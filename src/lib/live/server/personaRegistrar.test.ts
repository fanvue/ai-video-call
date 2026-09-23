import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  emailDomain,
  mintPersonaRegisterToken,
  personaIdForImage,
  personaRegistrar,
  registrarDomain,
  sha256Hex,
} from "./personaRegistrar";

const user = (email: unknown, extra: Record<string, unknown> = {}) => ({
  uuid: "user-uuid-1",
  email,
  ...extra,
});

describe("registrarDomain", () => {
  it("defaults to fanvue.com, trims and lowercases, and is off when set empty", () => {
    expect(registrarDomain(undefined)).toBe("fanvue.com");
    expect(registrarDomain(" Fanvue.COM ")).toBe("fanvue.com");
    expect(registrarDomain("")).toBeNull();
    expect(registrarDomain("   ")).toBeNull();
  });
});

describe("emailDomain", () => {
  it("takes the part after the last @, trimmed and lowercased", () => {
    expect(emailDomain("x@Fanvue.com ")).toBe("fanvue.com");
    expect(emailDomain('"a@fanvue.com"@evil.io')).toBe("evil.io");
  });

  it("is null for anything unparseable", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "no-at-sign",
      "@fanvue.com",
      "x@",
      "x@ ",
      "x@fan vue.com",
    ]) {
      expect(emailDomain(value)).toBeNull();
    }
  });
});

describe("personaRegistrar", () => {
  it("accepts a fanvue.com session email in any case", () => {
    expect(personaRegistrar(user("x@fanvue.com"), "fanvue.com")).toEqual({
      uuid: "user-uuid-1",
    });
    expect(personaRegistrar(user("X@FANVUE.COM"), "fanvue.com")).toEqual({
      uuid: "user-uuid-1",
    });
  });

  it.each([
    "x@notfanvue.com",
    "x@fanvue.com.evil.io",
    "x@sub.fanvue.com",
    "x@fanvue.co",
    "fanvue.com",
  ])("rejects %s", (email) => {
    expect(personaRegistrar(user(email), "fanvue.com")).toBeNull();
  });

  it("rejects a missing email, a missing uuid and an unverified email", () => {
    expect(personaRegistrar({ uuid: "u" }, "fanvue.com")).toBeNull();
    expect(
      personaRegistrar({ email: "x@fanvue.com" }, "fanvue.com"),
    ).toBeNull();
    expect(personaRegistrar(null, "fanvue.com")).toBeNull();
    expect(
      personaRegistrar(
        user("x@fanvue.com", { emailVerified: false }),
        "fanvue.com",
      ),
    ).toBeNull();
    expect(
      personaRegistrar(
        user("x@fanvue.com", { isEmailVerified: false }),
        "fanvue.com",
      ),
    ).toBeNull();
    expect(
      personaRegistrar(
        user("x@fanvue.com", { isEmailVerified: true }),
        "fanvue.com",
      ),
    ).toEqual({ uuid: "user-uuid-1" });
  });

  it("nobody registers when the domain is off", () => {
    expect(personaRegistrar(user("x@fanvue.com"), null)).toBeNull();
  });
});

describe("persona ids and register tokens", () => {
  it("derives a deterministic id from the image hash", () => {
    const sha = sha256Hex(Buffer.from("same image"));
    expect(sha).toBe(sha256Hex(Buffer.from("same image")));
    expect(sha).not.toBe(sha256Hex(Buffer.from("other image")));
    expect(personaIdForImage(sha)).toBe(`upload-${sha.slice(0, 12)}`);
    expect(personaIdForImage(sha)).toMatch(/^upload-[0-9a-f]{12}$/);
  });

  it("signs a purpose-bound payload the Modal service can verify", () => {
    const secret = "s".repeat(64);
    const sha = sha256Hex(Buffer.from("img"));
    const token = mintPersonaRegisterToken(secret, 1_000_000, "user-1", sha);
    const [payloadPart, signature] = token.split(".");
    expect(
      createHmac("sha256", secret).update(payloadPart).digest("base64url"),
    ).toBe(signature);
    expect(
      JSON.parse(Buffer.from(payloadPart, "base64url").toString()),
    ).toEqual({
      purpose: "persona-register",
      uid: "user-1",
      sha256: sha,
      exp: 1300,
    });
  });
});
