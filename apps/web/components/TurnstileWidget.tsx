"use client";

import { useEffect, useRef } from "react";

type TurnstileApi = {
  render: (element: HTMLElement, options: {
    sitekey: string;
    action: string;
    size: "flexible";
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

type Props = {
  siteKey: string;
  action: string;
  onToken: (token: string) => void;
  onError: () => void;
  resetKey?: number;
};

export function TurnstileWidget({ siteKey, action, onToken, onError, resetKey = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tokenCallbackRef = useRef(onToken);
  const errorCallbackRef = useRef(onError);

  useEffect(() => { tokenCallbackRef.current = onToken; }, [onToken]);
  useEffect(() => { errorCallbackRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;
    let cancelled = false;
    let attempts = 0;
    let widgetId: string | null = null;
    const getTurnstile = () => (window as Window & { turnstile?: TurnstileApi }).turnstile;

    function renderWidget() {
      if (cancelled || widgetId || !containerRef.current) return;
      const turnstile = getTurnstile();
      if (!turnstile) {
        attempts += 1;
        if (attempts < 50) window.setTimeout(renderWidget, 100);
        return;
      }
      widgetId = turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action,
        size: "flexible",
        callback: (token) => tokenCallbackRef.current(token),
        "expired-callback": () => tokenCallbackRef.current(""),
        "error-callback": () => errorCallbackRef.current(),
      });
    }

    const scriptId = "continuixai-turnstile";
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.addEventListener("load", renderWidget, { once: true });
      document.head.appendChild(script);
    } else {
      renderWidget();
    }

    return () => {
      cancelled = true;
      const turnstile = getTurnstile();
      if (widgetId && turnstile) turnstile.remove(widgetId);
    };
  }, [action, resetKey, siteKey]);

  return <div ref={containerRef} className="auth-turnstile" aria-label="Security check" />;
}
