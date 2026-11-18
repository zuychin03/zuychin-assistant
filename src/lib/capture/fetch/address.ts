import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

export type AddressPolicy = (address: string) => boolean;
export type Resolver = (host: string) => Promise<LookupAddress[]>;

// NAT64, 6to4 and Teredo embed IPv4 addresses, so only plain unicast passes.
export const isPublicAddress: AddressPolicy = (address) => {
    if (!ipaddr.isValid(address)) return false;
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    return parsed.range() === "unicast";
};

export class AddressRefused extends Error {
    readonly code = "ADDRESS_REFUSED";
    constructor(readonly host: string) { super(`${host} does not resolve to a public address.`); this.name = "AddressRefused"; }
}

export const systemResolver: Resolver = (host) => new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
});

// Passed to http.request so the socket connects only to an address this check approved.
export function guardedLookup(policy: AddressPolicy, resolver: Resolver = systemResolver): LookupFunction {
    return (host, options, callback) => {
        const wanted = options.family === 4 || options.family === "IPv4" ? 4 : options.family === 6 || options.family === "IPv6" ? 6 : 0;
        resolver(host).then((addresses) => {
            if (!addresses.length) throw Object.assign(new Error(`${host} has no addresses.`), { code: "ENOTFOUND" });
            if (addresses.some((entry) => !policy(entry.address))) throw new AddressRefused(host);
            const usable = wanted ? addresses.filter((entry) => entry.family === wanted) : addresses;
            if (!usable.length) throw Object.assign(new Error(`${host} has no IPv${wanted} address.`), { code: "ENOTFOUND" });
            if (options.all) callback(null, usable);
            else callback(null, usable[0].address, usable[0].family);
        }).catch((error: NodeJS.ErrnoException) => callback(error, "", 0));
    };
}
