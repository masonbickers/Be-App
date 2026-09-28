// Shared reply boundary: never render internal routing instructions as coaching.
export const COACH_UNAVAILABLE_REPLY =
  "I couldn't get a full Coach response just now. Please try again in a moment.";

export function isInternalCoachReply(value) {
  const text = String(value || "").toLowerCase();
  return [
    "answer the latest question directly and keep the next step practical",
    "but answer what the user just asked",
    "if the user is asking for advice, give one conservative next step",
    "final_latest_message_rule",
    "user_context_json",
    "current_plan_json",
    "brief modifier from saved memory",
    "do not let it override the main training goal",
  ].some((instruction) => text.includes(instruction));
}

export function normaliseCoachReplyMessage(message) {
  if (message?.role !== "assistant") return message;
  if (!isInternalCoachReply(message.content)) {
    return String(message.id || "").startsWith("err-")
      ? { ...message, responseStatus: "limited", responseSource: "network_error" }
      : message;
  }
  return {
    ...message,
    content: COACH_UNAVAILABLE_REPLY,
    responseStatus: "limited",
    responseSource: "local_fallback",
  };
}
