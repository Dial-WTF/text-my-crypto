import { describe, expect, it } from "vitest";
import { parseDotenv } from "../../scripts/dotenv.mjs";

describe("parseDotenv (secrets:push)", () => {
  it("drops inline comments after unquoted values but keeps # inside them", () => {
    const text = [
      "# a comment line",
      "ALERT_PHONE=+15550000123 # owner",
      "ALCHEMY_API_KEY=abc#def",
      "EMPTY= # nothing here",
      "  SPACED  =  value with spaces   ",
      "export EXPORTED=yes",
      "",
      "not a pair",
    ].join("\n");
    expect(parseDotenv(text)).toEqual({
      ALERT_PHONE: "+15550000123",
      ALCHEMY_API_KEY: "abc#def",
      EMPTY: "",
      SPACED: "value with spaces",
      EXPORTED: "yes",
    });
  });

  it("takes quoted values as written and ignores what follows the closing quote", () => {
    const text = [
      'DOUBLE="a # not a comment" # but this is',
      "SINGLE='x=1 # y'   # trailing",
      'ESCAPED="say \\"hi\\"\\nnext\\\\"',
      "LITERAL='raw\\n'",
      'EMPTY_QUOTED=""',
      "WINDOWS=crlf\r",
    ].join("\n");
    expect(parseDotenv(text)).toEqual({
      DOUBLE: "a # not a comment",
      SINGLE: "x=1 # y",
      ESCAPED: 'say "hi"\nnext\\',
      LITERAL: "raw\\n",
      EMPTY_QUOTED: "",
      WINDOWS: "crlf",
    });
  });

  it("names the key, not the value, when a quote is never closed", () => {
    expect(() => parseDotenv('PAYPHONE_API_KEY="dial_test_secret')).toThrow(/^PAYPHONE_API_KEY: /);
    expect(() => parseDotenv('PAYPHONE_API_KEY="dial_test_secret')).not.toThrow(/dial_test_secret/);
  });
});
