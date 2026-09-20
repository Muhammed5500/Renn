"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArrowRight, Check, Copy } from "lucide-react";
import { AnimatedSphere } from "./animated-sphere";
import { REPO } from "@/lib/links";

const INSTALL = "npm install rennpay";

/** Every figure here is from the README and LIMITS.md. */
const stats = [
  { value: "600 → 1", label: "payments, one transaction", source: "DEMO SCENE 2" },
  { value: "190", label: "pairs per transaction", source: "MEASURED, TESTNET" },
  { value: "0.0009", label: "XLM per pair per batch", source: "VS 0.0024 FOR X402 EXACT" },
  { value: "0", label: "tokens leave the vault", source: "WHEN DEBTS NET OUT" },
];

export function HeroSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  const copy = () => {
    navigator.clipboard.writeText(INSTALL).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  };

  return (
    <section className="relative min-h-screen flex flex-col justify-center overflow-hidden">
      {/* Animated sphere background */}
      <div className="absolute right-0 top-1/2 -translate-y-1/2 w-[600px] h-[600px] lg:w-[800px] lg:h-[800px] opacity-40 pointer-events-none">
        <AnimatedSphere />
      </div>

      {/* Subtle grid lines */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-30">
        {[...Array(8)].map((_, i) => (
          <div
            key={`h-${i}`}
            className="absolute h-px bg-foreground/10"
            style={{ top: `${12.5 * (i + 1)}%`, left: 0, right: 0 }}
          />
        ))}
        {[...Array(12)].map((_, i) => (
          <div
            key={`v-${i}`}
            className="absolute w-px bg-foreground/10"
            style={{ left: `${8.33 * (i + 1)}%`, top: 0, bottom: 0 }}
          />
        ))}
      </div>

      <div className="relative z-10 max-w-[1400px] mx-auto px-6 lg:px-12 py-32 lg:py-40">
        {/* Eyebrow */}
        <div
          className={`mb-8 transition-all duration-700 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground">
            <span className="w-8 h-px bg-foreground/30" />
            An x402 v2 scheme on Stellar
          </span>
        </div>

        {/* Main headline */}
        <div className="mb-12">
          <h1
            className={`text-[clamp(2.75rem,10.5vw,9rem)] font-display leading-[0.9] tracking-tight transition-all duration-1000 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            }`}
          >
            <span className="block">Hundreds of payments.</span>
            <span className="block">
              <span className="relative inline-block">
                <span className="inline-flex">
                  {"One".split("").map((char, i) => (
                    <span
                      key={`one-${i}`}
                      className="inline-block animate-char-in"
                      style={{ animationDelay: `${300 + i * 60}ms` }}
                    >
                      {char}
                    </span>
                  ))}
                </span>
                <span className="absolute -bottom-2 left-0 right-0 h-3 bg-foreground/10" />
              </span>{" "}
              transaction.
            </span>
          </h1>
        </div>

        {/* Description */}
        <div className="grid lg:grid-cols-2 gap-12 lg:gap-24 items-end">
          <p
            className={`text-xl lg:text-2xl text-muted-foreground leading-relaxed max-w-xl transition-all duration-700 delay-200 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            An agent deposits once into a shared Soroban vault, then pays per API call
            with signed off-chain vouchers. Each payment clears in milliseconds, so the
            service is served on the same request.
          </p>

          {/* CTAs */}
          <div
            className={`flex flex-col sm:flex-row items-start gap-4 transition-all duration-700 delay-300 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            <Button
              asChild
              size="lg"
              className="bg-foreground hover:bg-foreground/90 text-background px-8 h-14 text-base rounded-full group"
            >
              <a href={REPO}>
                View the repository
                <ArrowRight className="w-4 h-4 ml-2 transition-transform group-hover:translate-x-1" />
              </a>
            </Button>
            <button
              type="button"
              onClick={copy}
              className="h-14 pl-6 pr-5 inline-flex items-center gap-4 rounded-full border border-foreground/20 hover:bg-foreground/5 transition-colors font-mono text-base"
              aria-label="Copy the install command"
            >
              {INSTALL}
              {copied ? (
                <Check className="w-4 h-4 text-green-600" />
              ) : (
                <Copy className="w-4 h-4 text-muted-foreground" />
              )}
            </button>
          </div>
        </div>

      </div>

      {/* Stats marquee - full width outside container */}
      <div
        className={`absolute bottom-24 left-0 right-0 transition-all duration-700 delay-500 ${
          isVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="flex gap-16 marquee whitespace-nowrap">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex gap-16">
              {stats.map((stat) => (
                <div key={`${stat.source}-${i}`} className="flex items-baseline gap-4">
                  <span className="text-4xl lg:text-5xl font-display">{stat.value}</span>
                  <span className="text-sm text-muted-foreground">
                    {stat.label}
                    <span className="block font-mono text-xs mt-1">{stat.source}</span>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
