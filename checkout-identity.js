import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const GIT_DIRECTORY_POINTER = /^gitdir: (.+)$/;

// No Git invocation, host discovery, registry reads or writes. HEAD is deliberately
// excluded: commits change within an incarnation, replacement directories do not.
export async function inspectCheckoutIdentity(target, fs) {
  const unknown = (reason) => Object.freeze({ known: false, reason });
  function fingerprint(stat) {
    if (
      !stat.isDirectory() ||
      typeof stat.birthtimeNs !== 'bigint' ||
      stat.birthtimeNs <= 0n ||
      stat.ino <= 0n
    ) {
      throw new Error('Filesystem incarnation evidence unavailable');
    }
    return Object.freeze({
      birthtimeNs: String(stat.birthtimeNs),
      dev: String(stat.dev),
      ino: String(stat.ino),
    });
  }
  try {
    const checkoutPath = await fs.realpath(target.wtDir);
    const repositoryPath = await fs.realpath(target.repoDir);
    const gitFile = resolve(checkoutPath, '.git');
    const checkout = fingerprint(await fs.stat(checkoutPath, { bigint: true }));
    const repository = fingerprint(
      await fs.stat(repositoryPath, { bigint: true })
    );
    const pointer = (await fs.readFile(gitFile, 'utf8'))
      .trim()
      .match(GIT_DIRECTORY_POINTER);
    if (!pointer) {
      return unknown('Checkout has no linked-worktree Git pointer');
    }
    const adminPath = await fs.realpath(resolve(checkoutPath, pointer[1]));
    const beneath = relative(resolve(repositoryPath, 'worktrees'), adminPath);
    if (
      !beneath ||
      isAbsolute(beneath) ||
      beneath === '..' ||
      beneath.startsWith(`..${sep}`)
    ) {
      return unknown('Git administration is outside the expected repository');
    }
    const common = await fs.realpath(
      resolve(
        adminPath,
        (await fs.readFile(resolve(adminPath, 'commondir'), 'utf8')).trim()
      )
    );
    const backlink = await fs.realpath(
      resolve(
        adminPath,
        (await fs.readFile(resolve(adminPath, 'gitdir'), 'utf8')).trim()
      )
    );
    if (
      common !== repositoryPath ||
      backlink !== (await fs.realpath(gitFile)) ||
      dirname(backlink) !== checkoutPath
    ) {
      return unknown('Git administration does not point back to this checkout');
    }
    const admin = fingerprint(await fs.stat(adminPath, { bigint: true }));
    const result = {
      admin,
      adminPath,
      checkout,
      checkoutPath,
      known: true,
      repository,
      repositoryPath,
    };
    // Reject replacement during the read itself, as well as between operations.
    const unchanged = async (path, evidence) =>
      JSON.stringify(fingerprint(await fs.stat(path, { bigint: true }))) ===
      JSON.stringify(evidence);
    if (
      !(
        (await unchanged(checkoutPath, checkout)) &&
        (await unchanged(repositoryPath, repository)) &&
        (await unchanged(adminPath, admin))
      )
    ) {
      return unknown('Filesystem identity changed during observation');
    }
    return Object.freeze(result);
  } catch {
    return unknown('Checkout incarnation could not be established');
  }
}
