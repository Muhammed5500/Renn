"use client";

import { useEffect, useRef, useState } from "react";

const features = [
  {
    number: "01",
    title: "No bounced cheques",
    description:
      "A voucher is accepted only if the payer's spendable balance covers it, and the check happens before the service is delivered. The unbacked payment never exists, so there is nothing to claw back and no dispute window to wait out.",
    visual: "spend",
  },
  {
    number: "02",
    title: "Money circulates",
    description:
      "Incoming money counts immediately. The same 10 units move all day: A pays B, B pays C, C pays A, and nobody tops up. One deposit works against everyone in the vault, including agents you have never met.",
    visual: "circulate",
  },
  {
    number: "03",
    title: "Two signatures, or nothing",
    description:
      "Every accepted voucher carries the payer's signature and the operator's, over domain-separated payloads that name the network and the vault. The contract checks both, so the ledger cannot be bypassed and the operator cannot forge.",
    visual: "signatures",
  },
  {
    number: "04",
    title: "Your money stays yours",
    description:
      "Withdraw what you hold and the operator signs it on the spot, with no batch and no extra transaction. If it refuses or disappears, exit_start opens an escape hatch that does not need it at all.",
    visual: "exit",
  },
];

/** The spendable balance, and a payment that runs past it. */
function SpendVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full" aria-hidden="true">
      {/* the vault balance track */}
      <rect x="20" y="58" width="160" height="34" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />

      {/* spendable, filling and draining */}
      <rect x="22" y="60" width="100" height="30" fill="currentColor" opacity="0.15">
        <animate attributeName="width" values="40;116;70;116;40" dur="6s" repeatCount="indefinite" />
      </rect>

      {/* the limit */}
      <line x1="138" y1="48" x2="138" y2="102" stroke="currentColor" strokeWidth="2" />
      <text x="138" y="40" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.6">
        spendable
      </text>

      {/* an accepted payment */}
      <g>
        <rect x="30" y="112" width="52" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.7" />
        <text x="56" y="124" textAnchor="middle" fontSize="8" fontFamily="monospace" fill="currentColor" opacity="0.7">
          accepted
        </text>
      </g>

      {/* a payment past the line, refused */}
      <g>
        <rect x="118" y="112" width="52" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.45" />
        <text x="144" y="124" textAnchor="middle" fontSize="8" fontFamily="monospace" fill="currentColor" opacity="0.45">
          refused
        </text>
        <line x1="150" y1="100" x2="162" y2="88" stroke="currentColor" strokeWidth="2" opacity="0.5" />
        <line x1="162" y1="100" x2="150" y2="88" stroke="currentColor" strokeWidth="2" opacity="0.5" />
      </g>
    </svg>
  );
}

/** A pays B, B pays C, C pays A. The same money, going round. */
function CirculateVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full" aria-hidden="true">
      <path id="ring" d="M 100 30 L 160 125 L 40 125 Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.4" />

      {[
        { x: 100, y: 30, label: "A" },
        { x: 160, y: 125, label: "B" },
        { x: 40, y: 125, label: "C" },
      ].map((n) => (
        <g key={n.label}>
          <circle cx={n.x} cy={n.y} r="17" fill="var(--background)" stroke="currentColor" strokeWidth="2" />
          <text x={n.x} y={n.y + 5} textAnchor="middle" fontSize="14" fontFamily="monospace" fill="currentColor">
            {n.label}
          </text>
        </g>
      ))}

      {/* the payment travelling the cycle */}
      <circle r="5" fill="currentColor">
        <animateMotion dur="3.5s" repeatCount="indefinite" rotate="auto">
          <mpath href="#ring" />
        </animateMotion>
      </circle>

      <text x="100" y="100" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        one deposit
      </text>
    </svg>
  );
}

/** One voucher, two seals: the payer's and the operator's. */
function SignaturesVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full" aria-hidden="true">
      {/* voucher */}
      <rect x="38" y="28" width="124" height="104" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x="54" y={46 + i * 14} width={i === 2 ? 56 : 92} height="6" rx="2" fill="currentColor" opacity="0.15" />
      ))}

      {/* payer seal */}
      <g>
        <circle cx="72" cy="108" r="14" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25">
          <animate attributeName="opacity" values="0.25;1;1;0.25" dur="4s" repeatCount="indefinite" />
        </circle>
        <text x="72" y="112" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor">
          sig
        </text>
      </g>

      {/* operator seal */}
      <g>
        <circle cx="128" cy="108" r="14" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25">
          <animate attributeName="opacity" values="0.25;0.25;1;0.25" dur="4s" repeatCount="indefinite" />
        </circle>
        <text x="128" y="112" textAnchor="middle" fontSize="8" fontFamily="monospace" fill="currentColor">
          op
        </text>
      </g>

      <text x="100" y="150" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        the contract checks both
      </text>
    </svg>
  );
}

/** The vault, and the door that opens without the operator. */
function ExitVisual() {
  return (
    <svg viewBox="0 0 200 160" className="w-full h-full" aria-hidden="true">
      {/* vault */}
      <rect x="28" y="34" width="104" height="92" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="80" cy="80" r="22" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.4" />
      <circle cx="80" cy="80" r="7" fill="currentColor" opacity="0.5" />
      {[0, 90, 180, 270].map((a) => {
        const r = (a * Math.PI) / 180;
        return (
          <line
            key={a}
            x1={80 + Math.cos(r) * 10}
            y1={80 + Math.sin(r) * 10}
            x2={80 + Math.cos(r) * 22}
            y2={80 + Math.sin(r) * 22}
            stroke="currentColor"
            strokeWidth="2"
            opacity="0.4"
          />
        );
      })}

      {/* the way out */}
      <line x1="132" y1="80" x2="172" y2="80" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4">
        <animate attributeName="stroke-dashoffset" values="0;-9" dur="0.7s" repeatCount="indefinite" />
      </line>
      <path d="M 166 74 L 174 80 L 166 86" fill="none" stroke="currentColor" strokeWidth="2" />

      <text x="152" y="66" textAnchor="middle" fontSize="8" fontFamily="monospace" fill="currentColor" opacity="0.6">
        withdraw
      </text>
      <text x="100" y="146" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        no operator required
      </text>
    </svg>
  );
}

function AnimatedVisual({ type }: { type: string }) {
  switch (type) {
    case "spend":
      return <SpendVisual />;
    case "circulate":
      return <CirculateVisual />;
    case "signatures":
      return <SignaturesVisual />;
    case "exit":
      return <ExitVisual />;
    default:
      return <SpendVisual />;
  }
}

function FeatureCard({ feature, index }: { feature: typeof features[0]; index: number }) {
  const [isVisible, setIsVisible] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setIsVisible(true);
      },
      { threshold: 0.2 }
    );

    if (cardRef.current) observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={cardRef}
      className={`group relative transition-all duration-700 ${
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-12"
      }`}
      style={{ transitionDelay: `${index * 100}ms` }}
    >
      <div className="flex flex-col lg:flex-row gap-8 lg:gap-16 py-12 lg:py-20 border-b border-foreground/10">
        {/* Number */}
        <div className="shrink-0">
          <span className="font-mono text-sm text-muted-foreground">{feature.number}</span>
        </div>

        {/* Content */}
        <div className="flex-1 grid lg:grid-cols-2 gap-8 items-center">
          <div>
            <h3 className="text-3xl lg:text-4xl font-display mb-4 group-hover:translate-x-2 transition-transform duration-500">
              {feature.title}
            </h3>
            <p className="text-lg text-muted-foreground leading-relaxed">
              {feature.description}
            </p>
          </div>

          {/* Visual */}
          <div className="flex justify-center lg:justify-end">
            <div className="w-48 h-40 text-foreground">
              <AnimatedVisual type={feature.visual} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FeaturesSection() {
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

  return (
    <section id="rules" ref={sectionRef} className="relative py-24 lg:py-32">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        {/* Header */}
        <div className="mb-16 lg:mb-24">
          <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
            <span className="w-8 h-px bg-foreground/30" />
            The rules
          </span>
          <h2
            className={`text-4xl lg:text-6xl font-display tracking-tight transition-all duration-700 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
            }`}
          >
            Spend what you hold.
            <br />
            <span className="text-muted-foreground">Nothing more.</span>
          </h2>

          <div className="mt-10 max-w-3xl border border-foreground/10 p-6 lg:p-8 font-mono text-sm lg:text-base leading-loose overflow-x-auto">
            <div>spendable(x) = on-chain balance</div>
            <div className="text-muted-foreground">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- reserved withdrawals</div>
            <div className="text-muted-foreground">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;+ unsettled incoming</div>
            <div className="text-muted-foreground">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;- unsettled outgoing</div>
          </div>
          <p className="mt-6 max-w-3xl text-lg text-muted-foreground leading-relaxed">
            Signing vouchers off chain is fast and free, and it hides one thing: a payer&apos;s
            total commitments. Somebody holding 20 can sign 20 to B and 20 to C, and both see
            20 on chain. Renn keeps that number in one ordered place and makes the contract
            respect it.
          </p>
        </div>

        {/* Features List */}
        <div>
          {features.map((feature, index) => (
            <FeatureCard key={feature.number} feature={feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}
