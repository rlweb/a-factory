import { describe, expect, it } from "vitest";
import { type AnswerContext, decideResume, isApproval, questionCapReached } from "./trust.js";

function ctx(over: Partial<AnswerContext> = {}): AnswerContext {
  return {
    authorType: "User",
    association: "NONE",
    isMarkedBot: false,
    maintainerApproved: false,
    ...over,
  };
}

describe("decideResume", () => {
  it("ignores comments authored by a bot", () => {
    expect(decideResume(ctx({ authorType: "Bot" }))).toBe("ignore");
  });

  it("ignores the factory's own marked comments (never answers itself)", () => {
    expect(decideResume(ctx({ isMarkedBot: true }))).toBe("ignore");
  });

  it.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "resumes immediately for trusted association %s",
    (association) => {
      expect(decideResume(ctx({ association }))).toBe("resume");
    },
  );

  it("is case-insensitive on association", () => {
    expect(decideResume(ctx({ association: "collaborator" }))).toBe("resume");
  });

  it.each(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"])(
    "holds an unapproved answer from untrusted association %s",
    (association) => {
      expect(decideResume(ctx({ association }))).toBe("hold");
    },
  );

  it("resumes an untrusted answer once a maintainer has approved", () => {
    expect(decideResume(ctx({ association: "NONE", maintainerApproved: true }))).toBe("resume");
  });

  it("bot-check takes precedence over maintainer approval", () => {
    // A marked/bot comment is ignored even if somehow flagged approved.
    expect(decideResume(ctx({ authorType: "Bot", maintainerApproved: true }))).toBe("ignore");
  });
});

describe("isApproval", () => {
  it.each(["approve", "approved", "/approve", "LGTM", "lgtm", "go ahead", "Ship it"])(
    "accepts %j as approval",
    (body) => {
      expect(isApproval(body)).toBe(true);
    },
  );

  it("accepts an approval token followed by extra commentary", () => {
    expect(isApproval("approve — nice split, thanks")).toBe(true);
    expect(isApproval("LGTM, go for it")).toBe(true);
  });

  it("accepts an approval on the first line with detail underneath", () => {
    expect(isApproval("approve\n\nBut keep an eye on the migration in T0.")).toBe(true);
  });

  it("skips quoted lines so replying above a quoted proposal works", () => {
    expect(isApproval("> ### Proposed breakdown\n> 1. **A** (M)\n\napprove")).toBe(true);
  });

  // The reason this is anchored rather than a substring search: every one of these would
  // otherwise create tickets the human was arguing against.
  it.each([
    "I don't approve of splitting T2 that way",
    "not approved yet — T1 is too big",
    "Do not approve this, the roles are wrong",
    "hold off, lgtm once you fix T0",
    "no, go ahead only after the schema lands",
  ])("rejects the negated approval %j", (body) => {
    expect(isApproval(body)).toBe(false);
  });

  it("rejects an approval token buried mid-comment", () => {
    expect(isApproval("Split T0 further, then I'll approve")).toBe(false);
    expect(isApproval("Some feedback first.\n\napprove")).toBe(false);
  });

  it("rejects plain revision feedback", () => {
    expect(isApproval("Use owner/manager/staff for the role vocabulary.")).toBe(false);
  });

  it("rejects empty and whitespace-only comments", () => {
    expect(isApproval("")).toBe(false);
    expect(isApproval("   \n\n  ")).toBe(false);
    expect(isApproval(undefined as unknown as string)).toBe(false);
  });

  it("rejects a longer word that merely starts with a token", () => {
    expect(isApproval("approvals are handled elsewhere")).toBe(false);
  });
});

describe("questionCapReached", () => {
  it("is never reached when cap is 0 (uncapped)", () => {
    expect(questionCapReached(0, 0)).toBe(false);
    expect(questionCapReached(99, 0)).toBe(false);
  });

  it("is reached at or beyond the cap", () => {
    expect(questionCapReached(1, 2)).toBe(false);
    expect(questionCapReached(2, 2)).toBe(true);
    expect(questionCapReached(3, 2)).toBe(true);
  });
});
