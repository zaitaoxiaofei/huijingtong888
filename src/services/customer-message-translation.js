import { chatWithAiProvider } from "./ai-provider-settings.js";

export async function translateCustomerMessageTemplateZh(body = {}) {
  const scenario = String(body.scenario || "").trim();
  const label = String(body.label || body.name || scenario || "customer message template").trim();
  const text = String(body.template_text || body.text || "").trim();
  if (!text) return { ok: true, translated_text: "", template_translation: "" };

  const result = await chatWithAiProvider({
    temperature: 0.1,
    maxTokens: 700,
    messages: [
      {
        role: "system",
        content: [
          "Translate the Russian customer message template into Chinese for an ecommerce operator.",
          "Output Chinese only. Do not output Russian, Markdown, headings, or explanations.",
          "Preserve template variables exactly, including braces, for example {{posting_number}}, {{product_summary}}, {{status_label}}, and {{shop_name}}.",
          "Translate only human-readable Russian text. Place variables naturally in the Chinese sentence.",
          "Keep the tone natural and concise for an operations-side reference translation.",
          "If the source template has multiple lines, preserve a similar line structure when practical."
        ].join("\n")
      },
      {
        role: "user",
        content: `Scenario: ${label}\n\nTranslate this Russian template into Chinese and preserve all {{variables}}:\n${text}`
      }
    ]
  });
  const translated = String(result.content || "")
    .replace(/^```[a-zA-Z]*\s*/g, "")
    .replace(/```$/g, "")
    .trim();
  return {
    ok: true,
    translated_text: translated,
    template_translation: translated,
    provider: result.provider,
    model: result.model
  };
}
