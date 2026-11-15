import { describe, expect, it } from "vitest";
import { type Capability, assertCan, can, isPublic, ownsListing, uuidOr404 } from "./access";

const actor = (role: "user" | "agent" | "admin") => ({ id: `${role}-1`, role });

describe("capabilities", () => {
  const expected: Record<Capability, string[]> = {
    "listing:manage": ["agent"],
    "inquiry:manage": ["agent"],
    "favorite:manage": ["user"],
    "inquiry:create": ["user"],
    "inquiry:read-own": ["user"],
    "admin:stats": ["admin"],
    "admin:roles": ["admin"],
    "admin:hide": ["admin"],
  };

  it("grants each capability to exactly its role: admin is not a superset of agent, agents aren't admins", () => {
    for (const [cap, roles] of Object.entries(expected) as [Capability, string[]][]) {
      for (const role of ["user", "agent", "admin"] as const) {
        expect(can(actor(role), cap), `${role} ${cap}`).toBe(roles.includes(role));
      }
      expect(can(null, cap)).toBe(false);
    }
  });

  it("assertCan: 401 without an actor, 403 for the wrong role", () => {
    expect(() => assertCan(null, "listing:manage")).toThrowError(expect.objectContaining({ status: 401 }));
    expect(() => assertCan(actor("admin"), "listing:manage")).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => assertCan(actor("agent"), "listing:manage")).not.toThrow();
  });
});

describe("row helpers", () => {
  it("isPublic: active and not hidden only", () => {
    expect(isPublic({ status: "active", hiddenAt: null })).toBe(true);
    expect(isPublic({ status: "active", hiddenAt: new Date() })).toBe(false);
    for (const status of ["draft", "pending", "sold", "withdrawn"]) expect(isPublic({ status, hiddenAt: null })).toBe(false);
  });

  it("ownsListing: only an agent who owns it", () => {
    expect(ownsListing(actor("agent"), { agentId: "agent-1" })).toBe(true);
    expect(ownsListing(actor("agent"), { agentId: "agent-2" })).toBe(false);
    expect(ownsListing({ id: "agent-1", role: "user" }, { agentId: "agent-1" })).toBe(false);
    expect(ownsListing({ id: "agent-1", role: "admin" }, { agentId: "agent-1" })).toBe(false);
    expect(ownsListing(null, { agentId: "agent-1" })).toBe(false);
  });

  it("uuidOr404: anything that isn't a uuid is a 404, not a 400", () => {
    expect(uuidOr404("3F2504E0-4F89-41D3-9A0C-0305E82C3301")).toBe("3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    for (const bad of ["", "nope", "1 or 1=1", "3f2504e0-4f89-41d3-9a0c-0305e82c33011"]) {
      expect(() => uuidOr404(bad)).toThrowError(expect.objectContaining({ status: 404 }));
    }
  });
});
