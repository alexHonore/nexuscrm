import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CallQualityPanel } from "@/components/telephony/call-quality-panel";
import type { CallQuality } from "@/lib/telephony/call-quality";
import en from "../messages/en/phone.json";
import fr from "../messages/fr/phone.json";

const h = vi.hoisted(() => ({ tel: {} as Record<string, unknown> }));
vi.mock("@/components/telephony/telephony-context", () => ({ useTelephony: () => h.tel }));

function render(locale: "en" | "fr" = "en") {
  // NextIntl requires children in its props type even with React.createElement.
  // eslint-disable-next-line react/no-children-prop
  return renderToStaticMarkup(createElement(NextIntlClientProvider, {
    locale, messages: { phone: locale === "fr" ? fr : en }, timeZone: "America/Toronto", now: new Date("2026-10-24T12:00:00Z"),
    children: createElement(CallQualityPanel),
  }));
}
const sample: CallQuality = {
  at: 1, level: "poor", connection: "connected", codec: "PCMU", roundTripMs: 40,
  outbound: { lossPercent: 8, jitterMs: 60 }, inbound: { lossPercent: 0, jitterMs: 4 },
  microphone: { name: "Test headset", state: "live", level: .1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};
beforeEach(() => { h.tel = { callState: "active", quality: null, held: false, exportQuality: vi.fn() }; });

describe("call quality feedback", () => {
  it("does not claim a healthy call while measurements are unavailable", () => {
    const html = render();
    expect(html).toContain("Incomplete measurements");
    expect(html).not.toContain("Network stable");
    expect(html).toContain("recipient&#x27;s carrier");
    expect(html).toContain("disabled");
  });
  it.each(["en", "fr"] as const)("renders the send direction and actionable degradation feedback in %s", (locale) => {
    h.tel.quality = sample;
    const html = render(locale);
    const text = locale === "fr" ? fr : en;
    expect(html).toContain(text.quality.sentLoss);
    expect(html).toContain(text.quality.poor);
    expect(html).toContain(text.quality.networkAdvice.replaceAll("'", "&#x27;"));
    expect(html).toContain("Test headset");
    expect(html).toContain("<meter");
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("quality.");
  });
  it("keeps the last call's report accessible after hangup without a live meter", () => {
    h.tel = { ...h.tel, callState: "idle", quality: sample };
    const html = render();
    expect(html).toContain("Last call connection");
    expect(html).toContain("Download quality report");
    expect(html).not.toContain("<meter");
  });
  it("does not show an audio fault warning during intentional hold", () => {
    h.tel = { ...h.tel, callState: "held", held: true, quality: sample };
    const html = render();
    expect(html).toContain("On hold");
    expect(html).not.toContain(en.quality.networkAdvice);
  });
});
