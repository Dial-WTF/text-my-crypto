"use client";

import { useEffect, useRef } from "react";
import styles from "./MatrixRain.module.css";

const GLYPHS = "ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789:.=*+-<>¦";
const CELL = 18;
const FRAME_MS = 50;

function readColors(el: HTMLElement): { head: string; trail: string; fade: string } {
  const css = getComputedStyle(el);
  return {
    head: css.getPropertyValue("--color-focus").trim() || "#cfffd8",
    trail: css.getPropertyValue("--color-on-canvas").trim() || "#00ff41",
    fade: css.getPropertyValue("--color-canvas").trim() || "#020a04",
  };
}

/** Digital rain behind the page. Draws only while visible; one still frame for reduced motion. */
export function MatrixRain() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let drops: number[] = [];
    let colors = readColors(document.documentElement);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `${CELL - 2}px ui-monospace, monospace`;
      drops = Array.from({ length: Math.ceil(window.innerWidth / CELL) }, () =>
        Math.floor((Math.random() * window.innerHeight) / CELL),
      );
      colors = readColors(document.documentElement);
    };

    const draw = () => {
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = colors.fade;
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
      ctx.globalAlpha = 1;
      drops.forEach((row, col) => {
        const glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? "0";
        const x = col * CELL;
        const y = row * CELL;
        ctx.fillStyle = colors.trail;
        ctx.fillText(glyph, x, y - CELL);
        ctx.fillStyle = colors.head;
        ctx.fillText(glyph, x, y);
        drops[col] = y > window.innerHeight && Math.random() > 0.975 ? 0 : row + 1;
      });
    };

    resize();
    window.addEventListener("resize", resize);

    if (reduced) {
      for (let i = 0; i < 60; i++) draw();
      return () => window.removeEventListener("resize", resize);
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (!timer && document.visibilityState === "visible") timer = setInterval(draw, FRAME_MS);
    };
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    document.addEventListener("visibilitychange", onVisibility);
    start();

    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={ref} className={styles.rain} aria-hidden="true" />;
}
