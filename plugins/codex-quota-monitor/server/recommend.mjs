// Deliberately transparent scenario rules, not a benchmark leaderboard.
export function recommend(models, objective = "balanced") {
  const targets = {
    economy: ["gpt-5.6-luna", "medium"],
    balanced: ["gpt-5.6-terra", "medium"],
    quality: ["gpt-6-astra", "high"],
  };
  const [id, desiredEffort] = targets[objective] || targets.balanced;
  const model = Array.isArray(models)
    ? models.find((m) => m && (m.model || m.id) === id && !m.hidden)
    : null;
  const unavailable = {
    model: null,
    reasoningEffort: null,
    reason: "推荐模型及推理档位尚未由当前账号 model/list 确认可用。",
    source: "内置透明场景规则，2026-09-07",
  };
  if (!model) return unavailable;
  const supported = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
        .map((item) => item?.reasoningEffort)
        .filter((value) => typeof value === "string")
    : [];
  const effort = supported.includes(desiredEffort)
    ? desiredEffort
    : supported.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : null;
  if (!effort) return unavailable;
  return {
    model: id,
    reasoningEffort: effort,
    reason: {
      economy: "适合边界明确的小改动；优先较低成本，复杂任务可手动升级。",
      balanced: "适合日常开发；采用平衡档，实际返工率仍需你评估。",
      quality: "适合难题和重要设计；优先能力，额度消耗通常更高。",
    }[objective],
    source:
      "内置场景规则 + 当前账号 model/list；非全球最优或社区实时排名。Fast 档不自动更改。",
  };
}
