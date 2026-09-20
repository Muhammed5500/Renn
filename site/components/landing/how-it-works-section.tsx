"use client";

import { useEffect, useRef, useState } from "react";

const steps = [
  {
    number: "I",
    title: "The agent signs a voucher",
    description:
      "The service answers 402 with its price, the vault and the ledger. The agent signs a cumulative total for that pair, not a transfer, and retries.",
    file: "voucher.json",
    code: `{
  "type": "voucher",
  "voucher": {
    "payer":      "<agent address>",
    "recipient":  "<service address>",
    "cumulative": "1250000",
    "signature":  "<ed25519 over batchv3>"
  }
}

// 0.125 in total for this pair,
// not 0.02 for this one call`,
  },
  {
    number: "II",
    title: "The ledger accepts or refuses",
    description:
      "It checks the spendable balance, gives the acceptance a sequence number and co-signs. The contract rejects any voucher without that second signature, so the ledger cannot be bypassed.",
    file: "POST /settle",
    code: `{
  "success":     true,
  "transaction": "",
  "network":     "stellar:testnet",
  "amount":      "200000",
  "extra": {
    "seq":               418,
    "operatorSignature": "<op_sig>",
    "payerSignature":    "<sig>"
  }
}

// transaction is empty on purpose:
// nothing went on chain. refusals name
// a reason: insufficient_spendable,
// stale, exiting, not_joined`,
  },
  {
    number: "III",
    title: "The service delivers, same request",
    description:
      "Milliseconds, and nothing has touched the chain. The recipient already holds a two-signature claim it can settle on chain by itself if it ever needs to.",
    file: "agent.ts",
    code: `const pay = wrapFetchWithPayment(fetch, client)
const res = await pay(
  "https://service.example/weather"
)

// 402 -> sign -> retry -> 200
// on-chain transactions so far: 0`,
  },
  {
    number: "IV",
    title: "One batch closes hundreds",
    description:
      "The ledger sends a prefix of the acceptance order as a single settle_batch. Every batch is solvent by construction, so on-chain netting never drops anyone, and the vault's token balance does not move.",
    file: "settle_batch",
    code: `{
  "total":   "31400000",
  "settled": 150,
  "stale":   0,
  "skipped": []
}

// skipped is empty, always:
// a prefix batch cannot overdraw`,
  },
];

export function HowItWorksSection() {
  const [activeStep, setActiveStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

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
      setActiveStep((prev) => (prev + 1) % steps.length);
    }, 6000);
    return () => clearInterval(interval);
  }, []);

  return (
    <section
      id="how-it-works"
      ref={sectionRef}
      className="relative py-24 lg:py-32 bg-foreground text-background overflow-hidden"
    >
      {/* Diagonal lines pattern */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none">
        <div className="absolute inset-0" style={{
          backgroundImage: `repeating-linear-gradient(
            -45deg,
            transparent,
            transparent 40px,
            currentColor 40px,
            currentColor 41px
          )`
        }} />
      </div>

      <div className="relative z-10 max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header */}
        <div className="mb-16 lg:mb-24">
          <span className="inline-flex items-center gap-3 text-sm font-mono text-background/50 mb-6">
            <span className="w-8 h-px bg-background/30" />
            How a payment clears
          </span>
          <h2
            className={`text-4xl lg:text-6xl font-display tracking-tight transition-all duration-700 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            Four steps.
            <br />
            <span className="text-background/50">One of them is on chain.</span>
          </h2>
        </div>

        {/* Main content */}
        <div className="grid lg:grid-cols-2 gap-16 lg:gap-24">
          {/* Steps */}
          <div className="space-y-0">
            {steps.map((step, index) => (
              <button
                key={step.number}
                type="button"
                onClick={() => setActiveStep(index)}
                className={`w-full text-left py-8 border-b border-background/10 transition-all duration-500 group ${
                  activeStep === index ? "opacity-100" : "opacity-40 hover:opacity-70"
                }`}
              >
                <div className="flex items-start gap-6">
                  <span className="font-display text-3xl text-background/30">{step.number}</span>
                  <div className="flex-1">
                    <h3 className="text-2xl lg:text-3xl font-display mb-3 group-hover:translate-x-2 transition-transform duration-300">
                      {step.title}
                    </h3>
                    <p className="text-background/60 leading-relaxed">
                      {step.description}
                    </p>

                    {/* Progress indicator */}
                    {activeStep === index && (
                      <div className="mt-4 h-px bg-background/20 overflow-hidden">
                        <div
                          className="h-full bg-background w-0"
                          style={{ animation: 'progress 6s linear forwards' }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Code display */}
          <div className="lg:sticky lg:top-32 self-start">
            <div className="border border-background/10 overflow-hidden">
              {/* Window header */}
              <div className="px-6 py-4 border-b border-background/10 flex items-center justify-between">
                <div className="flex gap-2">
                  <div className="w-3 h-3 rounded-full bg-background/20" />
                  <div className="w-3 h-3 rounded-full bg-background/20" />
                  <div className="w-3 h-3 rounded-full bg-background/20" />
                </div>
                <span className="text-xs font-mono text-background/40">{steps[activeStep].file}</span>
              </div>

              {/* Code content */}
              <div className="p-8 font-mono text-sm min-h-[300px]">
                <pre className="text-background/70">
                  {steps[activeStep].code.split('\n').map((line, lineIndex) => (
                    <div
                      key={`${activeStep}-${lineIndex}`}
                      className="leading-loose code-line-reveal"
                      style={{ animationDelay: `${lineIndex * 80}ms` }}
                    >
                      <span className="text-background/20 select-none w-8 inline-block">{lineIndex + 1}</span>
                      <span className="inline-flex">
                        {line.split('').map((char, charIndex) => (
                          <span
                            key={`${activeStep}-${lineIndex}-${charIndex}`}
                            className="code-char-reveal"
                            style={{ animationDelay: `${lineIndex * 80 + charIndex * 15}ms` }}
                          >
                            {char === ' ' ? ' ' : char}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </pre>
              </div>

              {/* Status */}
              <div className="px-6 py-4 border-t border-background/10 flex items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-mono text-background/40">
                  {activeStep === 3 ? "Settled on Stellar testnet" : "Off chain"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes progress {
          from { width: 0%; }
          to { width: 100%; }
        }

        .code-line-reveal {
          opacity: 0;
          transform: translateX(-8px);
          animation: lineReveal 0.4s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }

        @keyframes lineReveal {
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        .code-char-reveal {
          opacity: 0;
          filter: blur(8px);
          animation: charReveal 0.3s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }

        @keyframes charReveal {
          to {
            opacity: 1;
            filter: blur(0);
          }
        }
      `}</style>
    </section>
  );
}
