//! Minimal DNS responder for custom project domains: A -> 127.0.0.1, AAAA -> ::1 for
//! the configured domains and their subdomains, REFUSED for everything else.

use anyhow::{Context, Result};
use std::sync::{Arc, RwLock};
use tokio::net::UdpSocket;

const AA: u16 = 0x0400;
const RCODE_FORMERR: u16 = 1;
const RCODE_NOTIMP: u16 = 4;
const RCODE_REFUSED: u16 = 5;

fn header(id: u16, query_flags: u16, rcode: u16, aa: bool, qd: u16, an: u16) -> Vec<u8> {
    let flags = 0x8000 | (query_flags & 0x7800) | (query_flags & 0x0100) | if aa { AA } else { 0 } | rcode;
    let mut v = Vec::with_capacity(64);
    v.extend_from_slice(&id.to_be_bytes());
    v.extend_from_slice(&flags.to_be_bytes());
    v.extend_from_slice(&qd.to_be_bytes());
    v.extend_from_slice(&an.to_be_bytes());
    v.extend_from_slice(&[0, 0, 0, 0]);
    v
}

/// Parse an uncompressed qname starting at `pos`; returns (lowercased name without trailing dot, end position).
fn parse_qname(q: &[u8], mut pos: usize) -> Option<(String, usize)> {
    let mut name = String::new();
    loop {
        let len = *q.get(pos)? as usize;
        pos += 1;
        if len == 0 {
            return Some((name, pos));
        }
        if len & 0xC0 != 0 {
            return None; // compression (or reserved bits) not allowed in a question
        }
        let label = q.get(pos..pos + len)?;
        if !name.is_empty() {
            name.push('.');
        }
        name.push_str(&String::from_utf8_lossy(label).to_ascii_lowercase());
        pos += len;
    }
}

fn matches_domain(qname: &str, domains: &[String]) -> bool {
    domains.iter().any(|d| {
        let d = d.trim().trim_matches('.').to_ascii_lowercase();
        !d.is_empty() && (qname == d || qname.strip_suffix(&d).is_some_and(|rest| rest.ends_with('.')))
    })
}

/// Build the response for one query datagram; `None` means "send nothing".
pub fn answer(query: &[u8], domains: &[String]) -> Option<Vec<u8>> {
    if query.len() < 12 {
        return None;
    }
    let id = u16::from_be_bytes([query[0], query[1]]);
    let flags = u16::from_be_bytes([query[2], query[3]]);
    if flags & 0x8000 != 0 {
        return None; // a response, not a query
    }
    let opcode = (flags >> 11) & 0xF;
    let qdcount = u16::from_be_bytes([query[4], query[5]]);
    if opcode != 0 {
        return Some(header(id, flags, RCODE_NOTIMP, false, 0, 0));
    }
    if qdcount != 1 {
        return Some(header(id, flags, RCODE_FORMERR, false, 0, 0));
    }
    let Some((qname, end)) = parse_qname(query, 12) else {
        return Some(header(id, flags, RCODE_FORMERR, false, 0, 0));
    };
    let Some(tail) = query.get(end..end + 4) else {
        return Some(header(id, flags, RCODE_FORMERR, false, 0, 0));
    };
    let qtype = u16::from_be_bytes([tail[0], tail[1]]);
    let qclass = u16::from_be_bytes([tail[2], tail[3]]);
    let question = &query[12..end + 4];

    if !matches_domain(&qname, domains) {
        let mut r = header(id, flags, RCODE_REFUSED, false, 1, 0);
        r.extend_from_slice(question);
        return Some(r);
    }
    let rdata: Option<Vec<u8>> = match (qtype, qclass) {
        (1, 1) | (1, 255) => Some(vec![127, 0, 0, 1]),
        (28, 1) | (28, 255) => Some(std::net::Ipv6Addr::LOCALHOST.octets().to_vec()),
        _ => None,
    };
    let mut r = header(id, flags, 0, true, 1, rdata.is_some() as u16);
    r.extend_from_slice(question);
    if let Some(rd) = rdata {
        r.extend_from_slice(&[0xC0, 0x0C]);
        r.extend_from_slice(&qtype.to_be_bytes());
        r.extend_from_slice(&1u16.to_be_bytes());
        r.extend_from_slice(&0u32.to_be_bytes());
        r.extend_from_slice(&(rd.len() as u16).to_be_bytes());
        r.extend_from_slice(&rd);
    }
    Some(r)
}

/// Answer queries on UDP 127.0.0.1:`port` until the task is dropped. The domain list is
/// re-read per query so project changes apply without a restart.
pub async fn serve(port: u16, domains: Arc<RwLock<Vec<String>>>) -> Result<()> {
    let sock = UdpSocket::bind(("127.0.0.1", port)).await.with_context(|| format!("binding DNS on 127.0.0.1:{port}"))?;
    serve_on(sock, domains).await
}

async fn serve_on(sock: UdpSocket, domains: Arc<RwLock<Vec<String>>>) -> Result<()> {
    let mut buf = [0u8; 1500];
    loop {
        let (n, peer) = match sock.recv_from(&mut buf).await {
            Ok(x) => x,
            Err(_) => continue,
        };
        let list = domains.read().map(|d| d.clone()).unwrap_or_default();
        if let Some(resp) = answer(&buf[..n], &list) {
            let _ = sock.send_to(&resp, peer).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(name: &str, qtype: u16) -> Vec<u8> {
        let mut q = vec![0xAB, 0xCD, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for l in name.trim_end_matches('.').split('.') {
            q.push(l.len() as u8);
            q.extend_from_slice(l.as_bytes());
        }
        q.push(0);
        q.extend_from_slice(&qtype.to_be_bytes());
        q.extend_from_slice(&1u16.to_be_bytes());
        q
    }

    fn doms() -> Vec<String> {
        vec!["quivly.test".to_string()]
    }

    fn rcode(r: &[u8]) -> u8 {
        r[3] & 0xF
    }
    fn ancount(r: &[u8]) -> u16 {
        u16::from_be_bytes([r[6], r[7]])
    }

    #[test]
    fn a_record() {
        let q = query("web.quivly.test", 1);
        let r = answer(&q, &doms()).unwrap();
        assert_eq!(&r[..2], &[0xAB, 0xCD]);
        assert_ne!(r[2] & 0x04, 0, "AA");
        assert_ne!(r[2] & 0x80, 0, "QR");
        assert_ne!(r[2] & 0x01, 0, "RD echoed");
        assert_eq!(rcode(&r), 0);
        assert_eq!(ancount(&r), 1);
        assert_eq!(&r[r.len() - 4..], &[127, 0, 0, 1]);
        // pointer, type A, class IN, ttl 0, rdlen 4
        let a = &r[q.len()..];
        assert_eq!(a, &[0xC0, 0x0C, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1]);
    }

    #[test]
    fn apex_and_trailing_dot_and_case() {
        for n in ["quivly.test", "QUIVLY.Test.", "A.B.QuIvLy.TeSt"] {
            let r = answer(&query(n, 1), &doms()).unwrap();
            assert_eq!(rcode(&r), 0, "{n}");
            assert_eq!(ancount(&r), 1, "{n}");
        }
    }

    #[test]
    fn aaaa_record() {
        let r = answer(&query("x.quivly.test", 28), &doms()).unwrap();
        assert_eq!(ancount(&r), 1);
        let mut want = [0u8; 16];
        want[15] = 1;
        assert_eq!(&r[r.len() - 16..], &want);
    }

    #[test]
    fn other_types_are_nodata() {
        let r = answer(&query("x.quivly.test", 15), &doms()).unwrap();
        assert_eq!(rcode(&r), 0);
        assert_eq!(ancount(&r), 0);
        assert_ne!(r[2] & 0x04, 0);
    }

    #[test]
    fn outside_domain_refused() {
        let r = answer(&query("example.com", 1), &doms()).unwrap();
        assert_eq!(rcode(&r), 5);
        assert_eq!(ancount(&r), 0);
        assert_eq!(r[2] & 0x04, 0);
    }

    #[test]
    fn suffix_is_not_substring() {
        for n in ["notquivly.test", "quivly.test.evil.com", "quivly.testx"] {
            assert_eq!(rcode(&answer(&query(n, 1), &doms()).unwrap()), 5, "{n}");
        }
    }

    #[test]
    fn malformed() {
        assert!(answer(&[1, 2, 3], &doms()).is_none());
        // response packets ignored
        let mut resp = query("a.quivly.test", 1);
        resp[2] |= 0x80;
        assert!(answer(&resp, &doms()).is_none());
        // QDCOUNT 2
        let mut q = query("a.quivly.test", 1);
        q[5] = 2;
        assert_eq!(rcode(&answer(&q, &doms()).unwrap()), 1);
        // QDCOUNT 0
        q[5] = 0;
        assert_eq!(rcode(&answer(&q, &doms()).unwrap()), 1);
        // non-zero opcode
        let mut q = query("a.quivly.test", 1);
        q[2] |= 0x10;
        assert_eq!(rcode(&answer(&q, &doms()).unwrap()), 4);
        // truncated question
        let q = query("a.quivly.test", 1);
        assert_eq!(rcode(&answer(&q[..q.len() - 3], &doms()).unwrap()), 1);
        // compression pointer in question
        let mut q = vec![0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xC0, 0x0C, 0, 1, 0, 1];
        assert_eq!(rcode(&answer(&q, &doms()).unwrap()), 1);
        q.truncate(12);
        assert_eq!(rcode(&answer(&q, &doms()).unwrap()), 1);
    }

    #[tokio::test]
    async fn serves_over_udp() {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = sock.local_addr().unwrap().port();
        let list = Arc::new(RwLock::new(vec!["demo.test".to_string()]));
        let task = tokio::spawn(serve_on(sock, list.clone()));
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let mut buf = [0u8; 512];
        client.send_to(&query("x.demo.test", 1), ("127.0.0.1", port)).await.unwrap();
        let n = tokio::time::timeout(std::time::Duration::from_secs(2), client.recv(&mut buf)).await.unwrap().unwrap();
        assert_eq!(&buf[n - 4..n], &[127, 0, 0, 1]);
        // live domain updates
        list.write().unwrap().clear();
        client.send_to(&query("x.demo.test", 1), ("127.0.0.1", port)).await.unwrap();
        let n = tokio::time::timeout(std::time::Duration::from_secs(2), client.recv(&mut buf)).await.unwrap().unwrap();
        assert_eq!(rcode(&buf[..n]), 5);
        task.abort();
    }
}
