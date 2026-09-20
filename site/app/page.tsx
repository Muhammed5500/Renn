import { Navigation } from "@/components/landing/navigation";
import { HeroSection } from "@/components/landing/hero-section";
import { FeaturesSection } from "@/components/landing/features-section";
import { HowItWorksSection } from "@/components/landing/how-it-works-section";
import { PrivateEntrySection } from "@/components/landing/private-entry-section";
import { InfrastructureSection } from "@/components/landing/infrastructure-section";
import { DevelopersSection } from "@/components/landing/developers-section";
import { FooterSection } from "@/components/landing/footer-section";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-x-hidden noise-overlay">
      <Navigation />
      <HeroSection />
      <FeaturesSection />
      <HowItWorksSection />
      <PrivateEntrySection />
      <InfrastructureSection />
      <DevelopersSection />
      <FooterSection />
    </main>
  );
}
