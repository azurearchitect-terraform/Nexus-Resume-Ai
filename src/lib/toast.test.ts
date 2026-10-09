import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Toast } from "../components/UI";

test("notifications include an accessible right-side dismiss button for every type", () => {
  for (const type of ["success", "error", "info"] as const) {
    const markup = renderToStaticMarkup(createElement(Toast, {
      message: "Trend response unavailable", type, onClose: () => {},
    }));
    assert.ok(markup.includes('aria-label="Close notification"'));
    assert.ok(markup.includes('<button type="button"'));
    assert.ok(markup.includes("ml-auto"));
    assert.ok(markup.includes("bottom-4 right-4"));
    assert.ok(markup.includes(type === "error" ? 'role="alert"' : 'role="status"'));
    assert.ok(markup.indexOf("Trend response unavailable") < markup.indexOf("<button"));
  }
});
