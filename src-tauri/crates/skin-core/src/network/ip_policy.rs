//! IP address policy for the safe fetcher — binary CIDR matching, not string
//! prefixes. Covers the IANA special-purpose registries: loopback, private,
//! link-local, ULA, CGNAT, multicast, unspecified, documentation, reserved.

use std::net::IpAddr;

/// True when the IP is forbidden as a fetch target.
pub fn is_forbidden_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_v4(v4),
        IpAddr::V6(v6) => is_forbidden_v6(v6),
    }
}

fn is_forbidden_v4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    let [a, b, c, _] = o;
    match (a, b, c) {
        (0, _, _) => true,          // 0.0.0.0/8 "this network"
        (10, _, _) => true,         // RFC1918
        (100, 64..=127, _) => true, // CGNAT 100.64.0.0/10
        (127, _, _) => true,        // loopback
        (169, 254, _) => true,      // link-local
        (172, 16..=31, _) => true,  // RFC1918
        (192, 0, 0) => true,       // IETF protocol assignments
        (192, 0, 2) => true,       // TEST-NET-1
        (192, 88, 99) => true,     // 6to4 relay (deprecated)
        (192, 168, _) => true,     // RFC1918
        (198, 18, _) | (198, 19, _) => true, // benchmarking
        (198, 51, 100) => true,    // TEST-NET-2
        (203, 0, 113) => true,     // TEST-NET-3
        (240, _, _) => true,       // reserved (incl. 255.255.255.255 broadcast)
        _ => a >= 224,             // multicast + reserved + limited broadcast
    }
}

fn is_forbidden_v6(ip: std::net::Ipv6Addr) -> bool {
    let seg = ip.segments();
    // IPv4-mapped / IPv4-compatible: validate the embedded address.
    if seg[..5] == [0, 0, 0, 0, 0] && (seg[5] == 0 || seg[5] == 0xffff) {
        let v4 = std::net::Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            seg[6] as u8,
            (seg[7] >> 8) as u8,
            seg[7] as u8,
        );
        return is_forbidden_v4(v4);
    }
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    // fe80::/10 link-local — proper CIDR, not the old "fe80:" prefix match.
    if (seg[0] & 0xffc0) == 0xfe80 {
        return true;
    }
    match seg[0] {
        0xff00..=0xffff => true, // multicast ff00::/8
        0xfc00..=0xfdff => true, // ULA fc00::/7
        0x2001 => seg[1] == 0x0db8 || seg[1] == 0x0000, // documentation + Teredo
        0x0064 => seg[1] == 0xff9b, // 64:ff9b::/96 NAT64 (embeds IPv4)
        0x0100 => seg[1] == 0x0000 && (seg[2] & 0xff00) == 0, // discard-only 100::/64
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn forbidden_v4() {
        for ip in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255",
                   "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
                   "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "240.0.0.1"] {
            assert!(is_forbidden_ip(IpAddr::from_str(ip).unwrap()), "{ip} should be forbidden");
        }
    }

    #[test]
    fn allowed_v4() {
        for ip in ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.63.0.1", "100.128.0.1", "9.9.9.9"] {
            assert!(!is_forbidden_ip(IpAddr::from_str(ip).unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn forbidden_v6() {
        for ip in ["::1", "::", "fe80::1", "febf::1", "ff02::1", "fc00::1", "fd12::1",
                   "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "64:ff9b::1.2.3.4",
                   "100::1"] {
            assert!(is_forbidden_ip(IpAddr::from_str(ip).unwrap()), "{ip} should be forbidden");
        }
    }

    #[test]
    fn allowed_v6() {
        for ip in ["2606:4700::1111", "2001:4860:4860::8888"] {
            assert!(!is_forbidden_ip(IpAddr::from_str(ip).unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn link_local_cidr_not_string_prefix() {
        // fe80::/10 covers fe8x/fe9x/feaX/febx — the old code only matched "fe80:".
        for ip in ["fe80::1", "fe90::1", "fea0::1", "feb0::1"] {
            assert!(is_forbidden_ip(IpAddr::from_str(ip).unwrap()));
        }
    }
}
