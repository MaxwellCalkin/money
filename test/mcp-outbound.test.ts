import { describe, expect, it } from "vitest";
import {
  isAllowlistablePrivateIpAddress,
  isPrivateOrReservedIpAddress,
} from "../src/core/url-security.ts";
import { AgentFetchPolicy, parsePrivateFetchOrigins } from "../src/mcp/outbound.ts";

const publicResolver = async () => [{ address: "93.184.216.34" }];

describe("agent outbound fetch policy", () => {
  it("canonicalizes public HTTPS targets and rejects credential or fragment aliases", async () => {
    const policy = new AgentFetchPolicy({ resolver: publicResolver });
    expect((await policy.validate("https://EXAMPLE.com:443/report?q=1")).href)
      .toBe("https://example.com/report?q=1");
    expect((await policy.resolve("https://example.com/report")).addresses)
      .toEqual(["93.184.216.34"]);
    await expect(policy.validate("http://example.com/report")).rejects.toThrow(/HTTPS/);
    await expect(policy.validate("https://user:pass@example.com/report")).rejects.toThrow(/credentials/);
    await expect(policy.validate("https://example.com/report#same-request"))
      .rejects.toThrow(/fragment/);
  });

  it("rejects literal, resolved, and mixed private destinations", async () => {
    const publicPolicy = new AgentFetchPolicy({ resolver: publicResolver });
    await expect(publicPolicy.validate("https://169.254.169.254/latest/meta-data"))
      .rejects.toThrow(/private|reserved/);
    await expect(publicPolicy.validate("https://[fd00::1]/internal"))
      .rejects.toThrow(/private|reserved/);

    const rebound = new AgentFetchPolicy({
      resolver: async () => [
        { address: "93.184.216.34" },
        { address: "10.0.0.7" },
      ],
    });
    await expect(rebound.validate("https://mixed.example/report"))
      .rejects.toThrow(/resolves.*private/);
  });

  it("permits only an explicitly allowlisted private CLI origin", async () => {
    const policy = new AgentFetchPolicy({
      privateOrigins: JSON.stringify(["http://127.0.0.1:8080"]),
      resolver: async () => { throw new Error("literal targets must not use DNS"); },
    });
    expect((await policy.validate("http://127.0.0.1:8080/v1/tool")).href)
      .toBe("http://127.0.0.1:8080/v1/tool");
    await expect(policy.validate("http://127.0.0.1:8081/v1/tool"))
      .rejects.toThrow(/HTTPS|private/);
    expect(() => parsePrivateFetchOrigins('["http://127.0.0.1:8080/path"]'))
      .toThrow(/bare origins/);
  });

  it("does not turn a private-origin opt-in into public or reserved authority", async () => {
    const policy = new AgentFetchPolicy({
      privateOrigins: JSON.stringify([
        "http://public.example",
        "https://public-secure.example",
        "http://mixed.example",
        "http://93.184.216.34",
        "http://169.254.169.254",
      ]),
      resolver: async (hostname) => hostname === "mixed.example"
        ? [{ address: "10.0.0.7" }, { address: "93.184.216.34" }]
        : publicResolver(),
    });
    await expect(policy.validate("http://public.example/tool")).rejects.toThrow(/private/);
    await expect(policy.validate("https://public-secure.example/tool")).rejects.toThrow(/private/);
    await expect(policy.validate("http://mixed.example/tool")).rejects.toThrow(/private/);
    await expect(policy.validate("http://93.184.216.34/tool")).rejects.toThrow(/private/);
    await expect(policy.validate("http://169.254.169.254/tool")).rejects.toThrow(/private/);
  });

  it("limits exact private origins to explicit private-network ranges", async () => {
    const policy = new AgentFetchPolicy({
      privateOrigins: JSON.stringify([
        "https://internal.example",
        "http://overlay.example",
      ]),
      resolver: async (hostname) => [{
        address: hostname === "overlay.example" ? "100.100.0.1" : "10.20.30.40",
      }],
    });
    await expect(policy.validate("https://internal.example/tool")).resolves.toBeInstanceOf(URL);
    await expect(policy.validate("http://overlay.example/tool")).resolves.toBeInstanceOf(URL);
    expect(isAllowlistablePrivateIpAddress("fd00::1")).toBe(true);
    expect(isAllowlistablePrivateIpAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isAllowlistablePrivateIpAddress("169.254.169.254")).toBe(false);
    expect(isAllowlistablePrivateIpAddress("fe80::1")).toBe(false);
  });

  it("classifies metadata, private, documentation, mapped, and public IPs", () => {
    for (const address of [
      "10.0.0.1",
      "100.64.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "192.0.2.1",
      "192.88.99.1",
      "169.254.169.254",
      "::1",
      "100:0:0:1::1",
      "fd00::1",
      "fe80::1",
      "2001::1",
      "2001:1::4",
      "2001:2::1",
      "2001:100::1",
      "2001:20::1",
      "2001:db8::1",
      "2002:5db8:d822::1",
      "3fff::1",
      "5f00::1",
      "4000::1",
      "::ffff:127.0.0.1",
    ]) expect(isPrivateOrReservedIpAddress(address), address).toBe(true);
    expect(isPrivateOrReservedIpAddress("192.0.8.1")).toBe(false);
    expect(isPrivateOrReservedIpAddress("93.184.216.34")).toBe(false);
    expect(isPrivateOrReservedIpAddress("2001:1::1")).toBe(false);
    expect(isPrivateOrReservedIpAddress("2001:3::1")).toBe(false);
    expect(isPrivateOrReservedIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });
});
