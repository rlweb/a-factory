import { describe, expect, it } from "vitest";
import { type AnswerContext, decideResume, questionCapReached } from "./trust.js";

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
