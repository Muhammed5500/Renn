"use client";

import { useState, useEffect, useRef } from "react";
import { Copy, Check } from "lucide-react";
import { REPO, NPM, docs } from "@/lib/links";

/** Straight out of the README's "Use it" section. */
const codeExamples = [
  {
    label: "Install",
    code: `npm install rennpay

# or
pnpm add rennpay
yarn add rennpay`,
  },
  {
    label: "Pay",
    code: `import { Agent, Chain, TESTNET, BatchSettlementStellarClient } from "rennpay"
import { x402Client } from "@x402/core/client"
import { wrapFetchWithPayment } from "@x402/fetch"

const chain = new Chain({ ...TESTNET, hub: VAULT, token: TOKEN }, MY_ADDRESS)
const agent = new Agent({ address: MY_ADDRESS, seedHex: VOUCHER_SEED,
                          ledgerUrl: LEDGER, hub: HUB_CFG })

const client = new x402Client()
  .register("stellar:testnet", new BatchSettlementStellarClient(agent))

const pay = wrapFetchWithPayment(globalThis.fetch, client)
const res = await pay("https://service.example/weather")`,
  },
  {
    label: "Join",
    code: `import { A } from "rennpay/chain"

// once, before paying anyone
await chain.invoke(keypair, "join",
  [A.addr(MY_ADDRESS), A.bytes(agent.commitmentKey)])

await chain.invoke(keypair, "deposit",
  [A.addr(MY_ADDRESS), A.i128(100_000_000n)])`,
  },
  {
    label: "Sell",
    code: `import { BatchSettlementStellarServer } from "rennpay"
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server"
import { paymentMiddleware } from "@x402/express"

const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: LEDGER }))
  .register("stellar:testnet", new BatchSettlementStellarServer({ asset: TOKEN }))

app.use(paymentMiddleware({ "GET /weather": { accepts: {
  scheme: "batch-settlement", network: "stellar:testnet",
  payTo: MY_ADDRESS, price: "0.02" } } }, server))`,
  },
  {
    label: "Enter privately",
    code: `import { SppCli, privateOnboard } from "rennpay"

const spp = new SppCli({ bin: "spp", circuits: "./circuits",
                         deployment: "./spp-deployments.json",
                         relayUrl: LEDGER })

const f = await privateOnboard({ spp, wallet: "my-keys-alias",
                                 amount: 100_000_000n, chain,
                                 ledgerUrl: LEDGER })

// f.agent pays over x402 like any other agent.
// No wallet of yours appears in any of its transactions.
// Store f.secret and f.seedHex: nothing else can spend it.`,
  },
];

const features = [
  {
    title: "Real x402 v2",
    description: "Runs with the official @x402/core, @x402/express and @x402/fetch packages, unchanged.",
  },
  {
    title: "TypeScript native",
    description: "Typed payloads, byte-identical to the contract and checked against frozen vectors.",
  },
  {
    title: "Sellers need nothing",
    description: "Any address can be paid. No account, no registration, no signature, no chain call.",
  },
  {
    title: "Published and MIT",
    description: "On npm as rennpay, with the Stellar scheme binding written up as a spec.",
  },
];

const codeAnimationStyles = `
  .dev-code-line {
    opacity: 0;
    transform: translateX(-8px);
    animation: devLineReveal 0.4s cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }

  @keyframes devLineReveal {
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .dev-code-char {
    opacity: 0;
    filter: blur(8px);
    animation: devCharReveal 0.3s cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }

  @keyframes devCharReveal {
    to {
      opacity: 1;
      filter: blur(0);
    }
  }
`;

export function DevelopersSection() {
  const [activeTab, setActiveTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);

  const handleCopy = () => {
    navigator.clipboard.writeText(codeExamples[activeTab].code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
    <section id="developers" ref={sectionRef} className="relative py-24 lg:py-32 overflow-hidden border-t border-foreground/10">
      <style dangerouslySetInnerHTML={{ __html: codeAnimationStyles }} />
      <div className="max-w-[1400px] mx-auto px-6 lg:px-12">
        <div className="grid lg:grid-cols-2 gap-16 lg:gap-24 items-start">
          {/* Left: Content */}
          <div
            className={`transition-all duration-700 ${
              isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            }`}
          >
            <span className="inline-flex items-center gap-3 text-sm font-mono text-muted-foreground mb-6">
              <span className="w-8 h-px bg-foreground/30" />
              For developers
            </span>
            <h2 className="text-4xl lg:text-6xl font-display tracking-tight mb-8">
              One scheme to register.
              <br />
              <span className="text-muted-foreground">The rest is stock x402.</span>
            </h2>
            <p className="text-xl text-muted-foreground mb-12 leading-relaxed">
              Any agent or service already speaking x402 uses Renn by registering a single
              scheme. The facilitator is the ledger, so the paying side never learns anything
              new and the selling side never touches the chain.
            </p>

            {/* Features */}
            <div className="grid grid-cols-2 gap-6">
              {features.map((feature, index) => (
                <div
                  key={feature.title}
                  className={`transition-all duration-500 ${
                    isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
                  }`}
                  style={{ transitionDelay: `${index * 50 + 200}ms` }}
                >
                  <h3 className="font-medium mb-1">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Code block */}
          <div
            className={`lg:sticky lg:top-32 transition-all duration-700 delay-200 ${
              isVisible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-8"
            }`}
          >
            <div className="border border-foreground/10">
              {/* Tabs */}
              <div className="flex items-center border-b border-foreground/10 overflow-x-auto">
                {codeExamples.map((example, idx) => (
                  <button
                    key={example.label}
                    type="button"
                    onClick={() => setActiveTab(idx)}
                    className={`px-5 py-4 text-sm font-mono whitespace-nowrap transition-colors relative ${
                      activeTab === idx
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {example.label}
                    {activeTab === idx && (
                      <span className="absolute bottom-0 left-0 right-0 h-px bg-foreground" />
                    )}
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="px-4 py-4 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="Copy code"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-600" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>

              {/* Code content */}
              <div className="p-8 font-mono text-[13px] bg-foreground/[0.01] min-h-[300px] overflow-x-auto">
                <pre className="text-foreground/80">
                  {codeExamples[activeTab].code.split('\n').map((line, lineIndex) => (
                    <div
                      key={`${activeTab}-${lineIndex}`}
                      className="leading-loose dev-code-line whitespace-pre"
                      style={{ animationDelay: `${lineIndex * 80}ms` }}
                    >
                      <span className="inline-flex">
                        {line.split('').map((char, charIndex) => (
                          <span
                            key={`${activeTab}-${lineIndex}-${charIndex}`}
                            className="dev-code-char"
                            style={{ animationDelay: `${lineIndex * 80 + charIndex * 12}ms` }}
                          >
                            {char === ' ' ? ' ' : char}
                          </span>
                        ))}
                      </span>
                    </div>
                  ))}
                </pre>
              </div>
            </div>

            {/* Links */}
            <div className="mt-6 flex flex-wrap items-center gap-6 text-sm">
              <a href={docs.scheme} className="text-foreground hover:underline underline-offset-4">
                Read the scheme spec
              </a>
              <span className="text-foreground/20">|</span>
              <a href={NPM} className="text-muted-foreground hover:text-foreground transition-colors">
                npm
              </a>
              <span className="text-foreground/20">|</span>
              <a href={REPO} className="text-muted-foreground hover:text-foreground transition-colors">
                View on GitHub
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
