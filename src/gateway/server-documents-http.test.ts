import { describe, expect, it } from "vitest";
import { documentsTicketAuthorizesRead, mintDocumentsTicket } from "./server-documents-http.js";

const FLEET = { FLEET_TENANT_ID: "tenant-1" } as NodeJS.ProcessEnv;
const u = (p: string) => new URL(p, "http://gateway.local");

describe("documentsTicketAuthorizesRead", () => {
  const t = mintDocumentsTicket("t_user");

  it("lets a tenant ticket read originals and assets on a fleet Machine", () => {
    expect(documentsTicketAuthorizesRead("GET", u(`/api/documents/file/abc?t=${t}`), FLEET)).toBe(
      true,
    );
    expect(
      documentsTicketAuthorizesRead("HEAD", u(`/api/documents/assets/x.png?t=${t}`), FLEET),
    ).toBe(true);
  });

  it("never applies off the fleet (self-host keeps the cookie path)", () => {
    expect(documentsTicketAuthorizesRead("GET", u(`/api/documents/file/abc?t=${t}`), {})).toBe(
      false,
    );
  });

  it("does not cover uploads or other routes", () => {
    expect(documentsTicketAuthorizesRead("POST", u(`/api/documents/upload?t=${t}`), FLEET)).toBe(
      false,
    );
    expect(documentsTicketAuthorizesRead("GET", u(`/api/documents/upload?t=${t}`), FLEET)).toBe(
      false,
    );
    expect(documentsTicketAuthorizesRead("GET", u(`/api/sessions?t=${t}`), FLEET)).toBe(false);
  });

  it("rejects missing, forged, expired and namespace-less tickets", () => {
    expect(documentsTicketAuthorizesRead("GET", u("/api/documents/file/abc"), FLEET)).toBe(false);
    expect(documentsTicketAuthorizesRead("GET", u(`/api/documents/file/abc?t=${t}x`), FLEET)).toBe(
      false,
    );
    const expired = mintDocumentsTicket("t_user", -1000);
    expect(
      documentsTicketAuthorizesRead("GET", u(`/api/documents/file/abc?t=${expired}`), FLEET),
    ).toBe(false);
    const noNs = mintDocumentsTicket(undefined);
    expect(
      documentsTicketAuthorizesRead("GET", u(`/api/documents/file/abc?t=${noNs}`), FLEET),
    ).toBe(false);
  });
});
