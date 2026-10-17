import { createHash } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { callConnectedMcpTool, mcpStatus } from './mcp.js';

const failure = (code, error) => ({ code, error, ok: false });
const revisionPattern = /^[a-f0-9]{64}$/;

function safeText(value, limit = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

function stable(value) {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    );
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function validator(schema) {
  if (!(schema && typeof schema === 'object' && !Array.isArray(schema))) {
    return null;
  }
  try {
    return new AjvJsonSchemaValidator().getValidator(schema);
  } catch {
    return null;
  }
}

function revision(action) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        stable({
          inputSchema: action.inputSchema,
          mutates: action.mutates,
          serverId: action.serverId,
          title: action.title,
          tool: action.tool,
        })
      )
    )
    .digest('hex');
}

function inputHash(input) {
  return createHash('sha256')
    .update(JSON.stringify(stable(input)))
    .digest('hex');
}

function validAction(action) {
  return (
    action &&
    safeText(action.id, 100) &&
    safeText(action.serverId, 100) &&
    safeText(action.tool, 160) &&
    safeText(action.title, 160) &&
    typeof action.mutates === 'boolean' &&
    typeof action.revision === 'string' &&
    revisionPattern.test(action.revision) &&
    validator(action.inputSchema) !== null &&
    action.revision === revision(action)
  );
}

function inputMatches(schema, input) {
  const check = validator(schema);
  return !!check?.(input).valid;
}

function boundResult(result, limit) {
  let text;
  try {
    text = JSON.stringify(result);
  } catch {
    return { result: null, truncated: true };
  }
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= limit) {
    return { result, truncated: false };
  }
  const bytes = encoder.encode(text);
  const boundaries = [0];
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index];
    let width = 4;
    if (first < 0x80) {
      width = 1;
    } else if (first >= 0xc0 && first <= 0xdf) {
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      width = 3;
    }
    index += width;
    boundaries.push(index);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const fits = (boundary) => {
    const candidate = decoder.decode(bytes.subarray(0, boundary));
    return (
      encoder.encode(JSON.stringify({ text: candidate })).byteLength <= limit
    );
  };
  if (!fits(0)) {
    return { result: null, truncated: true };
  }
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(boundaries[middle])) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return {
    result: { text: decoder.decode(bytes.subarray(0, boundaries[low])) },
    truncated: true,
  };
}

export function createMcpActions({
  state,
  eventRecorder,
  now = () => Date.now(),
  id = () => crypto.randomUUID(),
  callTool = callConnectedMcpTool,
  tools = (serverId) => mcpStatus(serverId).tools,
  maxResultBytes = 64 * 1024,
}) {
  const record = eventRecorder?.record ?? eventRecorder;
  function saved(document = state.read('mcpActions')) {
    if (
      !(document && typeof document === 'object' && !Array.isArray(document))
    ) {
      throw new Error('corrupt action journal');
    }
    if (document.actions === undefined) {
      return [];
    }
    if (
      !(
        typeof document.actions === 'object' &&
        document.actions &&
        !Array.isArray(document.actions)
      )
    ) {
      throw new Error('corrupt action journal');
    }
    const actions = Object.values(document.actions);
    if (
      !Object.entries(document.actions).every(
        ([key, action]) => key === action?.id && validAction(action)
      )
    ) {
      throw new Error('corrupt action journal');
    }
    return actions;
  }
  function confirmation(action, input) {
    return {
      actionId: action.id,
      inputHash: inputHash(input),
      revision: action.revision,
      token: `action:${action.id}:${action.revision}:${inputHash(input)}`,
    };
  }
  function checked(actionId, input) {
    let action;
    try {
      action = saved().find((row) => row.id === actionId);
    } catch {
      return failure(
        'MCP_ACTION_STATE_CORRUPT',
        'Saved MCP actions are corrupt; repair them before invoking a tool'
      );
    }
    if (!action) {
      return failure(
        'MCP_ACTION_NOT_FOUND',
        'Save this MCP tool as an action before invoking it'
      );
    }
    if (!inputMatches(action.inputSchema, input)) {
      return failure(
        'MCP_ACTION_INPUT_INVALID',
        'The action input does not match its saved schema'
      );
    }
    const selected = tools(action.serverId)?.find(
      (tool) => tool?.name === action.tool
    );
    if (!(selected && same(selected.inputSchema, action.inputSchema))) {
      return failure(
        'MCP_TOOL_UNAVAILABLE',
        'The saved action server or tool is not connected'
      );
    }
    return { action, confirmation: confirmation(action, input) };
  }
  async function save(mapping) {
    const selected = tools(mapping?.serverId)?.find(
      (tool) => tool?.name === mapping?.tool
    );
    const action = {
      id: mapping?.id ?? id(),
      inputSchema: mapping?.inputSchema,
      mutates: mapping?.mutates,
      serverId: mapping?.serverId,
      title: mapping?.title,
      tool: mapping?.tool,
    };
    action.revision = revision(action);
    if (!validAction(action)) {
      return failure(
        'INVALID_MCP_ACTION',
        'Provide one server tool, title, mutation flag, and a valid input schema'
      );
    }
    if (!(selected && same(selected.inputSchema, action.inputSchema))) {
      return failure(
        'MCP_TOOL_UNAVAILABLE',
        'Connect the selected MCP server and choose one of its listed tools first'
      );
    }
    try {
      saved();
      await state.update('mcpActions', (document) => {
        saved(document);
        return {
          ...document,
          actions: { ...(document.actions ?? {}), [action.id]: action },
        };
      });
      return { action, ok: true };
    } catch {
      return failure(
        'MCP_ACTION_STATE_FAILED',
        'The reviewed MCP action could not be saved'
      );
    }
  }
  function preflight(actionId, input) {
    const checkedAction = checked(actionId, input);
    return checkedAction.ok === false
      ? checkedAction
      : { confirmation: checkedAction.confirmation, ok: true };
  }
  async function invoke(
    actionId,
    input,
    confirmationToken,
    { source = 'portal' } = {}
  ) {
    const checkedAction = checked(actionId, input);
    if (checkedAction.ok === false) {
      return checkedAction;
    }
    const { action } = checkedAction;
    if (confirmationToken !== checkedAction.confirmation.token) {
      return {
        ...failure(
          'MCP_ACTION_CONFIRMATION_REQUIRED',
          'Review this exact tool input and confirm before invoking it'
        ),
        confirmation: checkedAction.confirmation,
      };
    }
    const event = {
      at: now(),
      id: id(),
      kind: 'mcp-action',
      source,
      state: 'accepted',
      target: null,
    };
    try {
      const accepted = await record?.(event);
      if (accepted?.ok !== true) {
        throw new Error('recorder refused event');
      }
    } catch {
      return {
        ...failure(
          'MCP_ACTION_EVENT_FAILED',
          'The action could not be recorded, so it was not invoked'
        ),
        operationId: event.id,
        outcomeRecorded: false,
      };
    }
    const finish = async (outcomeState, result) => {
      let recorded = false;
      try {
        recorded =
          (
            await record?.({
              ...event,
              state: outcomeState,
              ...(result.code ? { code: result.code } : {}),
            })
          )?.ok === true;
      } catch {
        /* Keep the known tool outcome when its journal is unavailable. */
      }
      return {
        ...result,
        operationId: event.id,
        ...(recorded ? {} : { outcomeRecorded: false }),
      };
    };
    let called;
    try {
      called = await callTool(action.serverId, action.tool, input);
    } catch {
      return finish('unknown', {
        ...failure(
          'MCP_TOOL_CALL_UNKNOWN',
          'The connected MCP tool threw before its outcome was known'
        ),
        state: 'unknown',
      });
    }
    if (!called?.ok) {
      const outcomeState =
        called?.state === 'unknown' || called?.code?.includes('UNKNOWN')
          ? 'unknown'
          : 'failed';
      return finish(outcomeState, {
        ...failure(
          called?.code ?? 'MCP_TOOL_CALL_FAILED',
          called?.error ?? 'The connected MCP tool did not complete'
        ),
        ...boundResult(called?.result, maxResultBytes),
        state: outcomeState,
      });
    }
    return finish('completed', {
      action: { id: action.id, title: action.title },
      ok: true,
      ...boundResult(called.result, maxResultBytes),
    });
  }

  function list() {
    try {
      return { actions: saved(), ok: true };
    } catch {
      return failure(
        'MCP_ACTION_STATE_CORRUPT',
        'Saved MCP actions are corrupt; repair them before using MCP actions'
      );
    }
  }
  return Object.freeze({ invoke, list, preflight, save });
}
