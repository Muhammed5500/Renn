"use client";

import { useEffect, useState, useRef } from "react";
import { EyeOff, Fuel, KeyRound, ShieldCheck } from "lucide-react";
import { SPP_POOL, contract, demoTx, docs, tx } from "@/lib/links";

const points = [
  {
    icon: EyeOff,
    title: "Three wallets, one pool",
    description:
      "Known wallets deposit the same round amount into our SPP pool. The crowd of depositors is the anonymity set, so a bigger crowd and a longer wait both help.",
  },
  {
    icon: KeyRound,
    title: "Out to a fresh address",
    description:
      "The withdrawal names a brand new address. Its source and fee payer is the relayer, so no wallet of yours appears anywhere in that transaction.",
  },
  {
    icon: Fuel,
    title: "The fresh address never pays a fee",
    description:
      "The relayer opens the account with 0 XLM and fee-bumps its join and deposit. If the wallet paid even one fee, the chain would show the link.",
  },
  {
    icon: ShieldCheck,
    title: "The relayer signs three shapes",
    description:
      "An SPP withdrawal with a negative amount, a sponsorship for a new account, and a fee bump over the vault's join or deposit. check-private.ts submits nine other shapes and every one is refused.",
  },
];

/** W, W2, W3 -> SPP pool -> a fresh address -> the vault. */
function FlowDiagram() {
  const wallets = [22, 66, 110];
  return (
    <svg viewBox="0 0 440 175" className="w-full h-auto max-w-[520px] text-foreground" aria-label="Known wallets deposit into an SPP pool; a fresh address withdraws from it and enters the vault">
      {wallets.map((y, i) => (
        <g key={y}>
          <rect x="2" y={y} width="62" height="30" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
          <text x="33" y={y + 19} textAnchor="middle" fontSize="11" fontFamily="monospace" fill="currentColor" opacity="0.75">
            {i === 0 ? "W" : `W${i + 1}`}
          </text>
          <line x1="66" y1={y + 15} x2="112" y2="81" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" opacity="0.4">
            <animate attributeName="stroke-dashoffset" values="0;-8" dur="1.2s" begin={`${i * 0.25}s`} repeatCount="indefinite" />
          </line>
        </g>
      ))}

      <text x="78" y="26" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        deposit 10
      </text>

      {/* the pool */}
      <rect x="114" y="46" width="94" height="70" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="161" y="76" textAnchor="middle" fontSize="12" fontFamily="monospace" fill="currentColor">
        SPP pool
      </text>
      <text x="161" y="94" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        Groth16
      </text>

      {/* pool -> fresh address */}
      <line x1="208" y1="81" x2="252" y2="81" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4">
        <animate attributeName="stroke-dashoffset" values="0;-8" dur="1.2s" repeatCount="indefinite" />
      </line>
      <path d="M 246 76 L 254 81 L 246 86" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="230" y="70" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        withdraw
      </text>

      {/* the fresh address */}
      <rect x="256" y="58" width="76" height="46" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="294" y="80" textAnchor="middle" fontSize="12" fontFamily="monospace" fill="currentColor">
        F
      </text>
      <text x="294" y="95" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        0 XLM
      </text>

      {/* fresh address -> vault */}
      <line x1="332" y1="81" x2="372" y2="81" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4">
        <animate attributeName="stroke-dashoffset" values="0;-8" dur="1.2s" repeatCount="indefinite" />
      </line>
      <path d="M 366 76 L 374 81 L 366 86" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <text x="352" y="70" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        join
      </text>

      {/* the vault */}
      <rect x="376" y="58" width="62" height="46" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="407" y="86" textAnchor="middle" fontSize="11" fontFamily="monospace" fill="currentColor">
        Vault
      </text>

      {/* the relayer pays for everything on this side */}
      <line x1="214" y1="138" x2="438" y2="138" stroke="currentColor" strokeWidth="1" opacity="0.25" />
      <line x1="214" y1="132" x2="214" y2="144" stroke="currentColor" strokeWidth="1" opacity="0.25" />
      <line x1="438" y1="132" x2="438" y2="144" stroke="currentColor" strokeWidth="1" opacity="0.25" />
      <text x="326" y="160" textAnchor="middle" fontSize="9" fontFamily="monospace" fill="currentColor" opacity="0.5">
        every fee on this side paid by the relayer
      </text>
    </svg>
  );
}

export function PrivateEntrySection() {
  const [isVisible, setIsVisible] = useState(false);
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

  return (
    <section id="private" ref={sectionRef} className="relative py-24 lg:py-32 bg-foreground/[0.02] overflow-hidden">
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="grid lg:grid-cols-2 gap-16 lg:gap-24">
          {/* Left: Content */}
          <div
            className={`transition-all duration-700 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            }`}
          >
            <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
              <span className="w-8 h-px bg-foreground/30" />
              Private entry
            </span>
            <h2 className="text-4xl lg:text-6xl font-display tracking-tight mb-8">
              Deposits are public.
              <br />
              <span className="text-muted-foreground">Yours does not have to be.</span>
            </h2>
            <p className="text-xl text-muted-foreground leading-relaxed mb-10">
              Vault balances are pseudonymous, but a deposit shows the chain which wallet
              funded which address. An agent that wants those unlinked enters through a{" "}
              <a href="https://github.com/NethermindEth/stellar-private-payments" className="text-foreground hover:underline underline-offset-4">
                Stellar Private Payments
              </a>{" "}
              pool instead.
            </p>

            <FlowDiagram />

            <p className="mt-10 text-muted-foreground leading-relaxed">
              The pool is ours: Nethermind&apos;s pool contract, the unchanged wasm, deployed
              for our token with a blocklist-only policy. The vault contract did not change at
              all, the official SPP CLI runs unmodified, and proofs are generated on the
              agent&apos;s own machine.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-6 text-sm">
              <a href={tx(demoTx.privateEntry)} className="text-foreground hover:underline underline-offset-4">
                The withdrawal, on testnet
              </a>
              <span className="text-foreground/20">|</span>
              <a href={contract(SPP_POOL)} className="text-muted-foreground hover:text-foreground transition-colors">
                Our pool
              </a>
              <span className="text-foreground/20">|</span>
              <a href={docs.readme} className="text-muted-foreground hover:text-foreground transition-colors">
                How it is wired
              </a>
            </div>
          </div>

          {/* Right: Points */}
          <div className="grid gap-6 content-start">
            {points.map((point, index) => (
              <div
                key={point.title}
                className={`p-6 border border-foreground/10 hover:border-foreground/20 transition-all duration-500 group ${
                  isVisible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-8"
                }`}
                style={{ transitionDelay: `${index * 100}ms` }}
              >
                <div className="flex items-start gap-4">
                  <div className="shrink-0 w-10 h-10 flex items-center justify-center border border-foreground/10 group-hover:bg-foreground group-hover:text-background transition-colors duration-300">
                    <point.icon className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-medium mb-1 group-hover:translate-x-1 transition-transform duration-300">
                      {point.title}
                    </h3>
                    <p className="text-muted-foreground">{point.description}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* The honest part */}
        <div
          className={`mt-16 lg:mt-24 grid md:grid-cols-3 border border-foreground/10 transition-all duration-700 delay-300 ${
            isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <div className="p-8 border-b md:border-b-0 md:border-r border-foreground/10">
            <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-4">What it hides</h3>
            <p className="text-muted-foreground leading-relaxed">
              Which wallet funded the address that entered the vault. None of the fresh
              address&apos;s transactions carry a wallet of yours.
            </p>
          </div>
          <div className="p-8 border-b md:border-b-0 md:border-r border-foreground/10">
            <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-4">What stays public</h3>
            <p className="text-muted-foreground leading-relaxed">
              Amounts and timing, so use round amounts and leave time between the deposit and
              the withdrawal. The relayer also sees request IPs, which is a link off chain.
            </p>
          </div>
          <div className="p-8">
            <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground mb-4">What is not settled</h3>
            <p className="text-muted-foreground leading-relaxed">
              SPP is unaudited and its trusted setup is a local test setup. Inside the vault,
              payments are not private: the operator sees who pays whom.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
