"use client";

import { useEffect, useState, useRef } from "react";
import { ArrowUpRight } from "lucide-react";
import { demoTx, docs, tx } from "@/lib/links";

/** The demo scenes from the README, each one a real testnet run. */
const scenes = [
  { name: "Circular debt", detail: "A holds 20. 270 payments net out", result: "1 transaction", href: tx(demoTx.circular) },
  { name: "Scale", detail: "5 payers, 25 services, 600 payments", result: "1 transaction", href: tx(demoTx.scale) },
  { name: "Bounced cheque", detail: "An empty payer, and the same 10 promised twice", result: "refused", href: null },
  { name: "Withdrawal", detail: "Pays 3 of its 50, then withdraws 20", result: "no batch", href: tx(demoTx.withdraw) },
  { name: "Operator down", detail: "A recipient settles its own voucher", result: "settle_one", href: tx(demoTx.settleOne) },
  { name: "Private entry", detail: "Three wallets in, one fresh address out", result: "no link on chain", href: tx(demoTx.privateEntry) },
];

export function InfrastructureSection() {
  const [isVisible, setIsVisible] = useState(false);
  const [activeScene, setActiveScene] = useState(0);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.1 }
    );

    if (sectionRef.current) observer.observe(sectionRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      setActiveScene((prev) => (prev + 1) % scenes.length);
    }, 2400);
    return () => clearInterval(interval);
  }, []);

  return (
    <section id="measured" ref={sectionRef} className="relative py-24 lg:py-32 overflow-hidden">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="grid lg:grid-cols-2 gap-16 lg:gap-24 items-center">
          {/* Left: Content */}
          <div
            className={`transition-all duration-700 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 -translate-x-8"
            }`}
          >
            <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
              <span className="w-8 h-px bg-foreground/30" />
              Measured, not claimed
            </span>
            <h2 className="text-4xl lg:text-6xl font-display tracking-tight mb-8">
              Numbers from the
              <br />
              running system.
            </h2>
            <p className="text-xl text-muted-foreground leading-relaxed mb-12">
              The batch limit comes from a real simulation with two signature checks per
              voucher, and the fees are what the network charged. Testnet only, and mainnet
              is not measured. Nothing here is an estimate.
            </p>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-8">
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">190</div>
                <div className="text-sm text-muted-foreground">Pairs per transaction, the ledger runs at 150</div>
              </div>
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">0.0009</div>
                <div className="text-sm text-muted-foreground">XLM per pair per batch, against 0.0024 for x402 exact</div>
              </div>
              <div>
                <div className="text-4xl lg:text-5xl font-display mb-2">100</div>
                <div className="text-sm text-muted-foreground">Tests: 76 on the contract, 24 on the ledger</div>
              </div>
            </div>

            <div className="mt-10 flex flex-wrap items-center gap-6 text-sm">
              <a href={docs.limits} className="text-foreground hover:underline underline-offset-4">
                Read LIMITS.md
              </a>
              <span className="text-foreground/20">|</span>
              <a href={docs.notes} className="text-muted-foreground hover:text-foreground transition-colors">
                Known limits and what is left out
              </a>
            </div>
          </div>

          {/* Right: Demo scene list */}
          <div
            className={`transition-all duration-700 delay-200 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-8"
            }`}
          >
            <div className="border border-foreground/10">
              {/* Header */}
              <div className="px-6 py-4 border-b border-foreground/10 flex items-center justify-between">
                <span className="text-sm font-mono text-muted-foreground">npm run demo</span>
                <span className="flex items-center gap-2 text-xs font-mono text-green-600">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                  Stellar testnet
                </span>
              </div>

              {/* Scenes */}
              <div>
                {scenes.map((scene, index) => {
                  const body = (
                    <>
                      <div className="flex items-center gap-4 min-w-0">
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 transition-colors duration-300 ${
                            activeScene === index ? "bg-foreground" : "bg-foreground/20"
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="font-medium flex items-center gap-1.5">
                            {scene.name}
                            {scene.href && (
                              <ArrowUpRight className="w-3.5 h-3.5 opacity-0 group-hover:opacity-60 transition-opacity" />
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground truncate">{scene.detail}</div>
                        </div>
                      </div>
                      <span className="font-mono text-sm text-muted-foreground shrink-0 pl-4">{scene.result}</span>
                    </>
                  );

                  const className = `group px-6 py-5 border-b border-foreground/5 last:border-b-0 flex items-center justify-between transition-all duration-300 ${
                    activeScene === index ? "bg-foreground/[0.02]" : ""
                  }`;

                  return scene.href ? (
                    <a key={scene.name} href={scene.href} className={className}>
                      {body}
                    </a>
                  ) : (
                    <div key={scene.name} className={className}>
                      {body}
                    </div>
                  );
                })}
              </div>
            </div>

            <p className="mt-4 text-sm text-muted-foreground">
              Every payment in the demo is a full x402 round trip through the official
              packages. Nothing is mocked.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
