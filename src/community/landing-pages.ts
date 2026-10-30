/**
 * Landing Page Builder — Community Landing Pages System
 *
 * Features:
 * - Create and manage landing pages per community
 * - Link existing URLs or build from scratch
 * - Directory-based page storage with version history
 * - Component-based page building (Hero, Features, Testimonials, etc.)
 * - Edit session management for live editing
 * - Pre-built templates with community branding
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Landing page status
 */
export type PageStatus = "draft" | "published" | "archived";

/**
 * Page source type
 */
export type PageSourceType = "built" | "linked" | "imported";

/**
 * Component types available in the builder
 */
export type ComponentType =
  | "hero"
  | "features"
  | "testimonials"
  | "pricing"
  | "cta"
  | "form"
  | "faq"
  | "gallery"
  | "video"
  | "text"
  | "stats"
  | "team"
  | "footer"
  | "custom";

/**
 * Component variant for styling options
 */
export type ComponentVariant = "default" | "centered" | "split" | "minimal" | "bold";

/**
 * Base component properties
 */
export interface ComponentBase {
  id: string;
  type: ComponentType;
  variant: ComponentVariant;
  order: number;
  visible: boolean;
  customCss?: string;
  customClasses?: string;
}

/**
 * Hero section component
 */
export interface HeroComponent extends ComponentBase {
  type: "hero";
  headline: string;
  subheadline?: string;
  backgroundImage?: string;
  backgroundColor?: string;
  ctaText?: string;
  ctaUrl?: string;
  ctaSecondaryText?: string;
  ctaSecondaryUrl?: string;
  alignment: "left" | "center" | "right";
  overlay?: boolean;
  overlayOpacity?: number;
}

/**
 * Feature item within features component
 */
export interface FeatureItem {
  id: string;
  icon?: string;
  title: string;
  description: string;
  link?: string;
}

/**
 * Features grid component
 */
export interface FeaturesComponent extends ComponentBase {
  type: "features";
  title?: string;
  subtitle?: string;
  items: FeatureItem[];
  columns: 2 | 3 | 4;
  iconStyle: "emoji" | "icon" | "image" | "none";
}

/**
 * Testimonial item
 */
export interface TestimonialItem {
  id: string;
  quote: string;
  author: string;
  role?: string;
  company?: string;
  avatar?: string;
  rating?: number;
}

/**
 * Testimonials component
 */
export interface TestimonialsComponent extends ComponentBase {
  type: "testimonials";
  title?: string;
  subtitle?: string;
  items: TestimonialItem[];
  style: "cards" | "carousel" | "grid" | "quotes";
}

/**
 * Pricing tier
 */
export interface PricingTier {
  id: string;
  name: string;
  price: string;
  period?: string;
  description?: string;
  features: string[];
  ctaText: string;
  ctaUrl: string;
  highlighted?: boolean;
  badge?: string;
}

/**
 * Pricing table component
 */
export interface PricingComponent extends ComponentBase {
  type: "pricing";
  title?: string;
  subtitle?: string;
  tiers: PricingTier[];
  showToggle?: boolean;
  monthlyLabel?: string;
  yearlyLabel?: string;
}

/**
 * CTA button component
 */
export interface CtaComponent extends ComponentBase {
  type: "cta";
  headline: string;
  subheadline?: string;
  buttonText: string;
  buttonUrl: string;
  buttonStyle: "primary" | "secondary" | "outline" | "gradient";
  backgroundColor?: string;
  backgroundImage?: string;
}

/**
 * Form field
 */
export interface FormField {
  id: string;
  name: string;
  label: string;
  type: "text" | "email" | "phone" | "textarea" | "select" | "checkbox";
  placeholder?: string;
  required: boolean;
  options?: string[]; // For select type
}

/**
 * Lead capture form component
 */
export interface FormComponent extends ComponentBase {
  type: "form";
  title?: string;
  subtitle?: string;
  fields: FormField[];
  submitText: string;
  successMessage: string;
  webhookUrl?: string;
  redirectUrl?: string;
  integrations?: {
    mailchimp?: { listId: string };
    convertkit?: { formId: string };
    webhook?: { url: string; headers?: Record<string, string> };
  };
}

/**
 * FAQ item
 */
export interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

/**
 * FAQ component
 */
export interface FaqComponent extends ComponentBase {
  type: "faq";
  title?: string;
  subtitle?: string;
  items: FaqItem[];
  style: "accordion" | "list" | "grid";
}

/**
 * Stats item
 */
export interface StatItem {
  id: string;
  value: string;
  label: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Stats component
 */
export interface StatsComponent extends ComponentBase {
  type: "stats";
  title?: string;
  items: StatItem[];
  style: "horizontal" | "grid" | "cards";
}

/**
 * Text/content block component
 */
export interface TextComponent extends ComponentBase {
  type: "text";
  content: string; // Markdown or HTML
  format: "markdown" | "html";
}

/**
 * Video component
 */
export interface VideoComponent extends ComponentBase {
  type: "video";
  title?: string;
  videoUrl: string;
  provider: "youtube" | "vimeo" | "wistia" | "loom" | "custom";
  autoplay?: boolean;
  thumbnail?: string;
}

/**
 * Gallery item
 */
export interface GalleryItem {
  id: string;
  imageUrl: string;
  caption?: string;
  link?: string;
}

/**
 * Gallery component
 */
export interface GalleryComponent extends ComponentBase {
  type: "gallery";
  title?: string;
  items: GalleryItem[];
  columns: 2 | 3 | 4 | 5;
  style: "grid" | "masonry" | "carousel";
}

/**
 * Team member
 */
export interface TeamMember {
  id: string;
  name: string;
  role: string;
  avatar?: string;
  bio?: string;
  social?: {
    twitter?: string;
    linkedin?: string;
    github?: string;
  };
}

/**
 * Team component
 */
export interface TeamComponent extends ComponentBase {
  type: "team";
  title?: string;
  subtitle?: string;
  members: TeamMember[];
  columns: 2 | 3 | 4;
}

/**
 * Footer link
 */
export interface FooterLink {
  label: string;
  url: string;
}

/**
 * Footer column
 */
export interface FooterColumn {
  title: string;
  links: FooterLink[];
}

/**
 * Footer component
 */
export interface FooterComponent extends ComponentBase {
  type: "footer";
  logo?: string;
  tagline?: string;
  columns: FooterColumn[];
  copyright?: string;
  socialLinks?: {
    twitter?: string;
    instagram?: string;
    discord?: string;
    youtube?: string;
    linkedin?: string;
  };
}

/**
 * Custom HTML component
 */
export interface CustomComponent extends ComponentBase {
  type: "custom";
  html: string;
  css?: string;
  js?: string;
}

/**
 * Union of all component types
 */
export type PageComponent =
  | HeroComponent
  | FeaturesComponent
  | TestimonialsComponent
  | PricingComponent
  | CtaComponent
  | FormComponent
  | FaqComponent
  | StatsComponent
  | TextComponent
  | VideoComponent
  | GalleryComponent
  | TeamComponent
  | FooterComponent
  | CustomComponent;

/**
 * Page settings
 */
export interface PageSettings {
  title: string;
  description?: string;
  keywords?: string[];
  favicon?: string;
  ogImage?: string;
  customHead?: string; // Custom HTML for <head>
  customCss?: string;
  customJs?: string;
  analytics?: {
    googleAnalytics?: string;
    facebookPixel?: string;
    customScript?: string;
  };
  fonts?: {
    heading?: string;
    body?: string;
  };
  colors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    text?: string;
  };
}

/**
 * Page version for history
 */
export interface PageVersion {
  id: string;
  pageId: string;
  version: number;
  components: PageComponent[];
  settings: PageSettings;
  createdAt: string;
  createdBy?: string;
  note?: string;
}

/**
 * Landing page entity
 */
export interface LandingPage {
  id: string;
  communityId: string;
  name: string;
  slug: string;
  status: PageStatus;
  sourceType: PageSourceType;
  linkedUrl?: string; // For linked pages
  components: PageComponent[];
  settings: PageSettings;
  currentVersion: number;
  publishedVersion?: number;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
}

/**
 * Edit session for live editing
 */
export interface EditSession {
  id: string;
  pageId: string;
  communityId: string;
  userId?: string;
  startedAt: string;
  lastActivityAt: string;
  draftComponents: PageComponent[];
  draftSettings: PageSettings;
  hasUnsavedChanges: boolean;
}

/**
 * Page template
 */
export interface PageTemplate {
  id: string;
  name: string;
  description: string;
  category: "landing" | "sales" | "course" | "community" | "event" | "product";
  thumbnail?: string;
  components: PageComponent[];
  settings: Partial<PageSettings>;
  tags: string[];
}

// ═══════════════════════════════════════════════════════════════
// TEMPLATES - Pre-built landing page designs
// ═══════════════════════════════════════════════════════════════

const createId = () => randomUUID().slice(0, 8);

/**
 * Default community landing page template
 */
export const COMMUNITY_LANDING_TEMPLATE: PageTemplate = {
  id: "community-landing",
  name: "Community Hub",
  description: "Modern community landing page with features, testimonials, and join CTA",
  category: "community",
  tags: ["community", "membership", "modern"],
  components: [
    {
      id: createId(),
      type: "hero",
      variant: "centered",
      order: 0,
      visible: true,
      headline: "Join the Most Exclusive Community",
      subheadline: "Connect with like-minded individuals and level up together",
      backgroundColor: "#0a0a0a",
      ctaText: "Join Now",
      ctaUrl: "#join",
      ctaSecondaryText: "Learn More",
      ctaSecondaryUrl: "#features",
      alignment: "center",
      overlay: false,
    } as HeroComponent,
    {
      id: createId(),
      type: "stats",
      variant: "default",
      order: 1,
      visible: true,
      items: [
        { id: createId(), value: "10K+", label: "Members" },
        { id: createId(), value: "500+", label: "Resources" },
        { id: createId(), value: "24/7", label: "Support" },
        { id: createId(), value: "50+", label: "Live Events" },
      ],
      style: "horizontal",
    } as StatsComponent,
    {
      id: createId(),
      type: "features",
      variant: "default",
      order: 2,
      visible: true,
      title: "Everything You Need to Succeed",
      subtitle: "Access exclusive resources, mentorship, and a thriving community",
      columns: 3,
      iconStyle: "emoji",
      items: [
        {
          id: createId(),
          icon: "📚",
          title: "Exclusive Content",
          description: "Access premium courses, guides, and resources curated by experts",
        },
        {
          id: createId(),
          icon: "🤝",
          title: "Mentorship",
          description: "Get guidance from successful community members and leaders",
        },
        {
          id: createId(),
          icon: "💬",
          title: "Private Community",
          description: "Connect with like-minded individuals in our Discord community",
        },
        {
          id: createId(),
          icon: "🎯",
          title: "Accountability",
          description: "Stay on track with group challenges and progress tracking",
        },
        {
          id: createId(),
          icon: "🔥",
          title: "Weekly Calls",
          description: "Join live Q&A sessions and masterminds every week",
        },
        {
          id: createId(),
          icon: "🚀",
          title: "Fast Track",
          description: "Accelerate your growth with proven frameworks and systems",
        },
      ],
    } as FeaturesComponent,
    {
      id: createId(),
      type: "testimonials",
      variant: "default",
      order: 3,
      visible: true,
      title: "What Our Members Say",
      style: "cards",
      items: [
        {
          id: createId(),
          quote: "This community changed my life. The resources and connections are invaluable.",
          author: "Sarah J.",
          role: "Entrepreneur",
          rating: 5,
        },
        {
          id: createId(),
          quote: "Best investment I've made. The weekly calls alone are worth 10x the price.",
          author: "Mike R.",
          role: "Developer",
          rating: 5,
        },
        {
          id: createId(),
          quote: "Found my business partner here. The networking opportunities are incredible.",
          author: "Emma K.",
          role: "Founder",
          rating: 5,
        },
      ],
    } as TestimonialsComponent,
    {
      id: createId(),
      type: "pricing",
      variant: "default",
      order: 4,
      visible: true,
      title: "Choose Your Plan",
      subtitle: "Start your journey today",
      tiers: [
        {
          id: createId(),
          name: "Free",
          price: "$0",
          period: "forever",
          description: "Get started with basics",
          features: ["Community access", "Free resources", "Monthly newsletter"],
          ctaText: "Join Free",
          ctaUrl: "#join-free",
        },
        {
          id: createId(),
          name: "Premium",
          price: "$49",
          period: "/month",
          description: "Full community access",
          features: [
            "Everything in Free",
            "Premium courses",
            "Weekly calls",
            "Private channels",
            "1-on-1 support",
          ],
          ctaText: "Go Premium",
          ctaUrl: "#join-premium",
          highlighted: true,
          badge: "Most Popular",
        },
        {
          id: createId(),
          name: "VIP",
          price: "$199",
          period: "/month",
          description: "Maximum support & access",
          features: [
            "Everything in Premium",
            "Monthly 1-on-1 call",
            "Priority support",
            "VIP events",
            "Lifetime bonuses",
          ],
          ctaText: "Join VIP",
          ctaUrl: "#join-vip",
        },
      ],
    } as PricingComponent,
    {
      id: createId(),
      type: "faq",
      variant: "default",
      order: 5,
      visible: true,
      title: "Frequently Asked Questions",
      style: "accordion",
      items: [
        {
          id: createId(),
          question: "How do I join the community?",
          answer:
            "Simply choose a plan above and complete the signup. You'll get instant access to our Discord server and all included resources.",
        },
        {
          id: createId(),
          question: "Can I cancel anytime?",
          answer:
            "Yes! You can cancel your subscription at any time with no questions asked. Your access continues until the end of your billing period.",
        },
        {
          id: createId(),
          question: "What's included in the weekly calls?",
          answer:
            "Our weekly calls include Q&A sessions, guest expert interviews, and mastermind discussions. All calls are recorded for members who can't attend live.",
        },
        {
          id: createId(),
          question: "Is there a refund policy?",
          answer:
            "We offer a 14-day money-back guarantee. If you're not satisfied, contact us within 14 days for a full refund.",
        },
      ],
    } as FaqComponent,
    {
      id: createId(),
      type: "cta",
      variant: "centered",
      order: 6,
      visible: true,
      headline: "Ready to Transform Your Life?",
      subheadline: "Join thousands of members who are already achieving their goals",
      buttonText: "Join the Community",
      buttonUrl: "#join",
      buttonStyle: "gradient",
      backgroundColor: "#0a0a0a",
    } as CtaComponent,
    {
      id: createId(),
      type: "footer",
      variant: "default",
      order: 7,
      visible: true,
      tagline: "Building the future, together.",
      columns: [
        {
          title: "Community",
          links: [
            { label: "About", url: "#about" },
            { label: "Members", url: "#members" },
            { label: "Events", url: "#events" },
          ],
        },
        {
          title: "Resources",
          links: [
            { label: "Courses", url: "#courses" },
            { label: "Blog", url: "#blog" },
            { label: "Podcast", url: "#podcast" },
          ],
        },
        {
          title: "Support",
          links: [
            { label: "FAQ", url: "#faq" },
            { label: "Contact", url: "#contact" },
            { label: "Discord", url: "#discord" },
          ],
        },
      ],
      copyright: "© 2024 Community Hub. All rights reserved.",
      socialLinks: {
        twitter: "https://twitter.com",
        instagram: "https://instagram.com",
        discord: "https://discord.gg",
      },
    } as FooterComponent,
  ],
  settings: {
    title: "Community Hub - Join Us",
    description: "The most exclusive community for ambitious individuals",
    colors: {
      primary: "#D4AF37",
      secondary: "#1a1a1a",
      accent: "#FFD700",
      background: "#0a0a0a",
      text: "#e4e4e7",
    },
  },
};

/**
 * Sales page template
 */
export const SALES_PAGE_TEMPLATE: PageTemplate = {
  id: "sales-page",
  name: "Product Sales Page",
  description: "High-converting sales page with video, features, and urgency elements",
  category: "sales",
  tags: ["sales", "product", "conversion"],
  components: [
    {
      id: createId(),
      type: "hero",
      variant: "split",
      order: 0,
      visible: true,
      headline: "Finally, A Solution That Actually Works",
      subheadline: "Transform your results in just 30 days with our proven system",
      ctaText: "Get Started Now",
      ctaUrl: "#buy",
      alignment: "left",
    } as HeroComponent,
    {
      id: createId(),
      type: "video",
      variant: "centered",
      order: 1,
      visible: true,
      title: "Watch How It Works",
      videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      provider: "youtube",
      thumbnail: "",
    } as VideoComponent,
    {
      id: createId(),
      type: "features",
      variant: "default",
      order: 2,
      visible: true,
      title: "What You Get",
      columns: 3,
      iconStyle: "emoji",
      items: [
        {
          id: createId(),
          icon: "✅",
          title: "Complete System",
          description: "Everything you need to succeed in one place",
        },
        {
          id: createId(),
          icon: "📹",
          title: "50+ Video Lessons",
          description: "Step-by-step training you can follow at your own pace",
        },
        {
          id: createId(),
          icon: "📋",
          title: "Templates & Scripts",
          description: "Plug-and-play resources to save you time",
        },
        {
          id: createId(),
          icon: "💬",
          title: "Private Community",
          description: "Get support and accountability from peers",
        },
        {
          id: createId(),
          icon: "🎯",
          title: "Weekly Coaching",
          description: "Live Q&A calls to answer your questions",
        },
        {
          id: createId(),
          icon: "🔥",
          title: "Bonus Materials",
          description: "Exclusive extras worth over $500",
        },
      ],
    } as FeaturesComponent,
    {
      id: createId(),
      type: "testimonials",
      variant: "default",
      order: 3,
      visible: true,
      title: "Success Stories",
      style: "carousel",
      items: [
        {
          id: createId(),
          quote: "I made back my investment in the first week!",
          author: "John D.",
          role: "Business Owner",
          rating: 5,
        },
        {
          id: createId(),
          quote: "This is hands down the best program I've ever purchased.",
          author: "Lisa M.",
          role: "Freelancer",
          rating: 5,
        },
      ],
    } as TestimonialsComponent,
    {
      id: createId(),
      type: "cta",
      variant: "centered",
      order: 4,
      visible: true,
      headline: "Limited Time Offer",
      subheadline: "Get 50% off when you join today",
      buttonText: "Claim Your Spot",
      buttonUrl: "#buy",
      buttonStyle: "gradient",
    } as CtaComponent,
  ],
  settings: {
    title: "Get Started Today",
    colors: {
      primary: "#ef4444",
      accent: "#f97316",
      background: "#0a0a0a",
    },
  },
};

/**
 * Course landing template
 */
export const COURSE_LANDING_TEMPLATE: PageTemplate = {
  id: "course-landing",
  name: "Course Landing Page",
  description: "Professional course landing page with curriculum and enrollment CTA",
  category: "course",
  tags: ["course", "education", "online-learning"],
  components: [
    {
      id: createId(),
      type: "hero",
      variant: "centered",
      order: 0,
      visible: true,
      headline: "Master [Skill] in 8 Weeks",
      subheadline: "The complete course to take you from beginner to expert",
      ctaText: "Enroll Now",
      ctaUrl: "#enroll",
      alignment: "center",
    } as HeroComponent,
    {
      id: createId(),
      type: "stats",
      variant: "default",
      order: 1,
      visible: true,
      items: [
        { id: createId(), value: "8", label: "Weeks" },
        { id: createId(), value: "40+", label: "Lessons" },
        { id: createId(), value: "20+", label: "Projects" },
        { id: createId(), value: "1000+", label: "Students" },
      ],
      style: "horizontal",
    } as StatsComponent,
    {
      id: createId(),
      type: "features",
      variant: "default",
      order: 2,
      visible: true,
      title: "Course Curriculum",
      subtitle: "Everything covered in this comprehensive program",
      columns: 2,
      iconStyle: "emoji",
      items: [
        {
          id: createId(),
          icon: "📚",
          title: "Module 1: Foundations",
          description: "Build a solid understanding of the fundamentals",
        },
        {
          id: createId(),
          icon: "🔧",
          title: "Module 2: Core Skills",
          description: "Develop essential techniques and methods",
        },
        {
          id: createId(),
          icon: "🚀",
          title: "Module 3: Advanced Topics",
          description: "Take your skills to the next level",
        },
        {
          id: createId(),
          icon: "💼",
          title: "Module 4: Real Projects",
          description: "Apply everything with hands-on projects",
        },
      ],
    } as FeaturesComponent,
    {
      id: createId(),
      type: "form",
      variant: "centered",
      order: 3,
      visible: true,
      title: "Get Free Access to Module 1",
      subtitle: "Enter your email to start learning today",
      fields: [
        {
          id: createId(),
          name: "name",
          label: "Name",
          type: "text",
          placeholder: "Your name",
          required: true,
        },
        {
          id: createId(),
          name: "email",
          label: "Email",
          type: "email",
          placeholder: "your@email.com",
          required: true,
        },
      ],
      submitText: "Get Free Access",
      successMessage: "Check your email for access!",
    } as FormComponent,
    {
      id: createId(),
      type: "cta",
      variant: "centered",
      order: 4,
      visible: true,
      headline: "Ready to Start Learning?",
      subheadline: "Join 1000+ students already enrolled",
      buttonText: "Enroll Now - $297",
      buttonUrl: "#enroll",
      buttonStyle: "primary",
    } as CtaComponent,
  ],
  settings: {
    title: "Online Course - Enroll Today",
    colors: {
      primary: "#3b82f6",
      accent: "#8b5cf6",
      background: "#0f172a",
    },
  },
};

/**
 * All available templates
 */
export const PAGE_TEMPLATES: Record<string, PageTemplate> = {
  "community-landing": COMMUNITY_LANDING_TEMPLATE,
  "sales-page": SALES_PAGE_TEMPLATE,
  "course-landing": COURSE_LANDING_TEMPLATE,
};

// ═══════════════════════════════════════════════════════════════
// STORE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

const INFINIBOT_ROOT =
  process.env.INFINIBOT_ROOT ||
  process.env.INFINIBOT_STATE_DIR?.replace(/[\\/]state$/, "") ||
  process.cwd();
const DEFAULT_STATE_DIR = join(INFINIBOT_ROOT, "state", "community", "landing-pages");

// In-memory stores
let pages: Map<string, LandingPage> = new Map();
let versions: Map<string, PageVersion[]> = new Map();
let editSessions: Map<string, EditSession> = new Map();

/**
 * Landing Pages Store
 */
export class LandingPagesStore {
  private stateDir: string;
  private pagesFile: string;
  private versionsDir: string;

  constructor(stateDir?: string) {
    this.stateDir = stateDir || DEFAULT_STATE_DIR;
    this.pagesFile = join(this.stateDir, "pages.json");
    this.versionsDir = join(this.stateDir, "versions");
    this.ensureDirectories();
    this.load();
  }

  private ensureDirectories(): void {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
    if (!existsSync(this.versionsDir)) {
      mkdirSync(this.versionsDir, { recursive: true });
    }
  }

  private load(): void {
    try {
      if (existsSync(this.pagesFile)) {
        const data = JSON.parse(readFileSync(this.pagesFile, "utf-8"));
        pages = new Map(Object.entries(data.pages || {}));
        versions = new Map(Object.entries(data.versions || {}));
      }
    } catch (e) {
      console.error("[LandingPages] Failed to load state:", e);
      pages = new Map();
      versions = new Map();
    }
  }

  private save(): void {
    try {
      const data = {
        pages: Object.fromEntries(pages),
        versions: Object.fromEntries(versions),
        savedAt: new Date().toISOString(),
      };
      writeFileSync(this.pagesFile, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("[LandingPages] Failed to save state:", e);
    }
  }

  // ── Page Operations ──────────────────────────────────────────

  createPage(data: {
    communityId: string;
    name: string;
    slug?: string;
    sourceType?: PageSourceType;
    linkedUrl?: string;
    templateId?: string;
    createdBy?: string;
  }): LandingPage {
    const now = new Date().toISOString();
    const id = randomUUID();
    const slug = data.slug || this.generateSlug(data.name);

    // Get template components/settings if specified
    let components: PageComponent[] = [];
    let settings: PageSettings = { title: data.name };

    if (data.templateId && PAGE_TEMPLATES[data.templateId]) {
      const template = PAGE_TEMPLATES[data.templateId];
      // Deep clone and regenerate IDs
      components = JSON.parse(JSON.stringify(template.components)).map((c: PageComponent) => ({
        ...c,
        id: randomUUID().slice(0, 8),
      }));
      settings = { ...settings, ...template.settings };
    }

    const page: LandingPage = {
      id,
      communityId: data.communityId,
      name: data.name,
      slug,
      status: "draft",
      sourceType: data.sourceType || "built",
      linkedUrl: data.linkedUrl,
      components,
      settings,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: data.createdBy,
    };

    pages.set(id, page);

    // Create initial version
    this.createVersion(page, "Initial version");

    this.save();
    return page;
  }

  getPage(pageId: string): LandingPage | undefined {
    return pages.get(pageId);
  }

  getPageBySlug(communityId: string, slug: string): LandingPage | undefined {
    for (const page of pages.values()) {
      if (page.communityId === communityId && page.slug === slug) {
        return page;
      }
    }
    return undefined;
  }

  listPages(communityId?: string, status?: PageStatus): LandingPage[] {
    let result = Array.from(pages.values());

    if (communityId) {
      result = result.filter((p) => p.communityId === communityId);
    }

    if (status) {
      result = result.filter((p) => p.status === status);
    }

    return result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  updatePage(
    pageId: string,
    updates: Partial<
      Pick<LandingPage, "name" | "slug" | "status" | "components" | "settings" | "linkedUrl">
    >,
  ): LandingPage | undefined {
    const page = pages.get(pageId);
    if (!page) return undefined;

    const updated: LandingPage = {
      ...page,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    pages.set(pageId, updated);
    this.save();
    return updated;
  }

  deletePage(pageId: string): boolean {
    const deleted = pages.delete(pageId);
    if (deleted) {
      versions.delete(pageId);
      editSessions.delete(pageId);
      this.save();
    }
    return deleted;
  }

  publishPage(pageId: string): LandingPage | undefined {
    const page = pages.get(pageId);
    if (!page) return undefined;

    const now = new Date().toISOString();
    const updated: LandingPage = {
      ...page,
      status: "published",
      publishedVersion: page.currentVersion,
      publishedAt: now,
      updatedAt: now,
    };

    pages.set(pageId, updated);
    this.createVersion(updated, "Published");
    this.save();
    return updated;
  }

  unpublishPage(pageId: string): LandingPage | undefined {
    const page = pages.get(pageId);
    if (!page) return undefined;

    const updated: LandingPage = {
      ...page,
      status: "draft",
      updatedAt: new Date().toISOString(),
    };

    pages.set(pageId, updated);
    this.save();
    return updated;
  }

  // ── Version Operations ───────────────────────────────────────

  createVersion(page: LandingPage, note?: string): PageVersion {
    const pageVersions = versions.get(page.id) || [];
    const version: PageVersion = {
      id: randomUUID(),
      pageId: page.id,
      version: page.currentVersion,
      components: JSON.parse(JSON.stringify(page.components)),
      settings: JSON.parse(JSON.stringify(page.settings)),
      createdAt: new Date().toISOString(),
      createdBy: page.createdBy,
      note,
    };

    pageVersions.push(version);
    versions.set(page.id, pageVersions);
    return version;
  }

  getVersions(pageId: string): PageVersion[] {
    return versions.get(pageId) || [];
  }

  restoreVersion(pageId: string, versionId: string): LandingPage | undefined {
    const page = pages.get(pageId);
    const pageVersions = versions.get(pageId);
    if (!page || !pageVersions) return undefined;

    const version = pageVersions.find((v) => v.id === versionId);
    if (!version) return undefined;

    const updated: LandingPage = {
      ...page,
      components: JSON.parse(JSON.stringify(version.components)),
      settings: JSON.parse(JSON.stringify(version.settings)),
      currentVersion: page.currentVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    pages.set(pageId, updated);
    this.createVersion(updated, `Restored from version ${version.version}`);
    this.save();
    return updated;
  }

  // ── Edit Session Operations ──────────────────────────────────

  startEditSession(pageId: string, userId?: string): EditSession | undefined {
    const page = pages.get(pageId);
    if (!page) return undefined;

    // Check for existing session
    const existing = editSessions.get(pageId);
    if (existing) {
      // Update activity
      existing.lastActivityAt = new Date().toISOString();
      return existing;
    }

    const session: EditSession = {
      id: randomUUID(),
      pageId,
      communityId: page.communityId,
      userId,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      draftComponents: JSON.parse(JSON.stringify(page.components)),
      draftSettings: JSON.parse(JSON.stringify(page.settings)),
      hasUnsavedChanges: false,
    };

    editSessions.set(pageId, session);
    return session;
  }

  getEditSession(pageId: string): EditSession | undefined {
    return editSessions.get(pageId);
  }

  updateEditSession(
    pageId: string,
    updates: {
      components?: PageComponent[];
      settings?: PageSettings;
    },
  ): EditSession | undefined {
    const session = editSessions.get(pageId);
    if (!session) return undefined;

    if (updates.components) {
      session.draftComponents = updates.components;
      session.hasUnsavedChanges = true;
    }

    if (updates.settings) {
      session.draftSettings = updates.settings;
      session.hasUnsavedChanges = true;
    }

    session.lastActivityAt = new Date().toISOString();
    return session;
  }

  saveEditSession(pageId: string, note?: string): LandingPage | undefined {
    const session = editSessions.get(pageId);
    const page = pages.get(pageId);
    if (!session || !page) return undefined;

    const updated: LandingPage = {
      ...page,
      components: session.draftComponents,
      settings: session.draftSettings,
      currentVersion: page.currentVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    pages.set(pageId, updated);
    this.createVersion(updated, note || "Saved from edit session");

    // Update session state
    session.hasUnsavedChanges = false;
    session.lastActivityAt = new Date().toISOString();

    this.save();
    return updated;
  }

  endEditSession(pageId: string): boolean {
    return editSessions.delete(pageId);
  }

  listEditSessions(): EditSession[] {
    return Array.from(editSessions.values());
  }

  // ── Component Operations ─────────────────────────────────────

  addComponent(
    pageId: string,
    component: Omit<PageComponent, "id" | "order">,
    position?: number,
  ): LandingPage | undefined {
    const page = pages.get(pageId);
    if (!page) return undefined;

    const newComponent: PageComponent = {
      ...component,
      id: randomUUID().slice(0, 8),
      order: position ?? page.components.length,
    } as PageComponent;

    // Insert at position and reorder
    const components = [...page.components];
    if (position !== undefined) {
      components.splice(position, 0, newComponent);
      // Reorder
      components.forEach((c, i) => {
        c.order = i;
      });
    } else {
      components.push(newComponent);
    }

    return this.updatePage(pageId, { components });
  }

  updateComponent(
    pageId: string,
    componentId: string,
    updates: Partial<PageComponent>,
  ): LandingPage | undefined {
    const page = pages.get(pageId);
    if (!page) return undefined;

    const components = page.components.map((c) =>
      c.id === componentId ? ({ ...c, ...updates } as PageComponent) : c,
    );

    return this.updatePage(pageId, { components });
  }

  removeComponent(pageId: string, componentId: string): LandingPage | undefined {
    const page = pages.get(pageId);
    if (!page) return undefined;

    const components = page.components
      .filter((c) => c.id !== componentId)
      .map((c, i) => ({ ...c, order: i }));

    return this.updatePage(pageId, { components });
  }

  reorderComponents(pageId: string, componentIds: string[]): LandingPage | undefined {
    const page = pages.get(pageId);
    if (!page) return undefined;

    const componentMap = new Map(page.components.map((c) => [c.id, c]));
    const components = componentIds
      .map((id, i) => {
        const c = componentMap.get(id);
        return c ? { ...c, order: i } : null;
      })
      .filter((c): c is PageComponent => c !== null);

    return this.updatePage(pageId, { components });
  }

  // ── Template Operations ──────────────────────────────────────

  getTemplates(): PageTemplate[] {
    return Object.values(PAGE_TEMPLATES);
  }

  getTemplate(templateId: string): PageTemplate | undefined {
    return PAGE_TEMPLATES[templateId];
  }

  cloneFromTemplate(
    templateId: string,
    data: {
      communityId: string;
      name: string;
      slug?: string;
      createdBy?: string;
    },
  ): LandingPage | undefined {
    const template = PAGE_TEMPLATES[templateId];
    if (!template) return undefined;

    return this.createPage({
      ...data,
      templateId,
    });
  }

  // ── Preview & Export ─────────────────────────────────────────

  generatePreviewHtml(pageId: string, draft: boolean = false): string {
    const page = pages.get(pageId);
    if (!page) return "";

    let components: PageComponent[];
    let settings: PageSettings;

    if (draft) {
      const session = editSessions.get(pageId);
      components = session?.draftComponents || page.components;
      settings = session?.draftSettings || page.settings;
    } else {
      components = page.components;
      settings = page.settings;
    }

    return this.renderPageHtml(components, settings);
  }

  private renderPageHtml(components: PageComponent[], settings: PageSettings): string {
    const colors = settings.colors || {};
    const fonts = settings.fonts || {};

    const css = `
      :root {
        --color-primary: ${colors.primary || "#D4AF37"};
        --color-secondary: ${colors.secondary || "#1a1a1a"};
        --color-accent: ${colors.accent || "#FFD700"};
        --color-background: ${colors.background || "#0a0a0a"};
        --color-text: ${colors.text || "#e4e4e7"};
        --font-heading: ${fonts.heading || "'Space Grotesk', system-ui, sans-serif"};
        --font-body: ${fonts.body || "'Inter', system-ui, sans-serif"};
      }
      
      * { box-sizing: border-box; margin: 0; padding: 0; }
      
      body {
        font-family: var(--font-body);
        background: var(--color-background);
        color: var(--color-text);
        line-height: 1.6;
      }
      
      .container { max-width: 1200px; margin: 0 auto; padding: 0 1.5rem; }
      
      .section { padding: 4rem 0; }
      
      h1, h2, h3, h4 { font-family: var(--font-heading); font-weight: 700; }
      
      h1 { font-size: 3rem; line-height: 1.1; }
      h2 { font-size: 2rem; margin-bottom: 1rem; }
      h3 { font-size: 1.25rem; }
      
      .btn {
        display: inline-block;
        padding: 0.875rem 2rem;
        border-radius: 0.5rem;
        font-weight: 600;
        text-decoration: none;
        transition: all 0.2s;
        cursor: pointer;
        border: none;
      }
      
      .btn-primary {
        background: var(--color-primary);
        color: var(--color-background);
      }
      
      .btn-gradient {
        background: linear-gradient(135deg, var(--color-primary), var(--color-accent));
        color: var(--color-background);
      }
      
      .btn:hover { transform: translateY(-2px); opacity: 0.9; }
      
      ${settings.customCss || ""}
    `;

    const componentHtml = components
      .filter((c) => c.visible)
      .sort((a, b) => a.order - b.order)
      .map((c) => this.renderComponent(c))
      .join("\n");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${settings.title}</title>
  ${settings.description ? `<meta name="description" content="${settings.description}">` : ""}
  ${settings.ogImage ? `<meta property="og:image" content="${settings.ogImage}">` : ""}
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${css}</style>
  ${settings.customHead || ""}
</head>
<body>
  ${componentHtml}
  ${settings.customJs ? `<script>${settings.customJs}</script>` : ""}
</body>
</html>`;
  }

  private renderComponent(component: PageComponent): string {
    switch (component.type) {
      case "hero":
        return this.renderHero(component);
      case "features":
        return this.renderFeatures(component);
      case "testimonials":
        return this.renderTestimonials(component);
      case "pricing":
        return this.renderPricing(component);
      case "cta":
        return this.renderCta(component);
      case "stats":
        return this.renderStats(component);
      case "faq":
        return this.renderFaq(component);
      case "footer":
        return this.renderFooter(component);
      case "text":
        return `<section class="section"><div class="container">${(component as TextComponent).content}</div></section>`;
      case "custom":
        return (component as CustomComponent).html || "";
      default:
        return `<!-- Unknown component: ${component.type} -->`;
    }
  }

  private renderHero(c: HeroComponent): string {
    const bgStyle = c.backgroundImage
      ? `background-image: url('${c.backgroundImage}'); background-size: cover;`
      : c.backgroundColor
        ? `background-color: ${c.backgroundColor};`
        : "";

    return `
    <section class="section hero" style="${bgStyle}; padding: 6rem 0; text-align: ${c.alignment};">
      <div class="container">
        <h1 style="margin-bottom: 1rem;">${c.headline}</h1>
        ${c.subheadline ? `<p style="font-size: 1.25rem; opacity: 0.8; margin-bottom: 2rem;">${c.subheadline}</p>` : ""}
        <div style="display: flex; gap: 1rem; justify-content: ${c.alignment};">
          ${c.ctaText ? `<a href="${c.ctaUrl || "#"}" class="btn btn-gradient">${c.ctaText}</a>` : ""}
          ${c.ctaSecondaryText ? `<a href="${c.ctaSecondaryUrl || "#"}" class="btn" style="border: 1px solid currentColor;">${c.ctaSecondaryText}</a>` : ""}
        </div>
      </div>
    </section>`;
  }

  private renderFeatures(c: FeaturesComponent): string {
    const items = c.items
      .map(
        (item) => `
      <div style="padding: 1.5rem; background: rgba(255,255,255,0.05); border-radius: 0.5rem;">
        ${item.icon ? `<div style="font-size: 2rem; margin-bottom: 1rem;">${item.icon}</div>` : ""}
        <h3 style="margin-bottom: 0.5rem;">${item.title}</h3>
        <p style="opacity: 0.7;">${item.description}</p>
      </div>
    `,
      )
      .join("");

    return `
    <section class="section">
      <div class="container">
        ${c.title ? `<h2 style="text-align: center;">${c.title}</h2>` : ""}
        ${c.subtitle ? `<p style="text-align: center; opacity: 0.7; margin-bottom: 2rem;">${c.subtitle}</p>` : ""}
        <div style="display: grid; grid-template-columns: repeat(${c.columns}, 1fr); gap: 1.5rem;">
          ${items}
        </div>
      </div>
    </section>`;
  }

  private renderTestimonials(c: TestimonialsComponent): string {
    const items = c.items
      .map(
        (item) => `
      <div style="padding: 1.5rem; background: rgba(255,255,255,0.05); border-radius: 0.5rem;">
        <p style="font-style: italic; margin-bottom: 1rem;">"${item.quote}"</p>
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          ${item.avatar ? `<img src="${item.avatar}" style="width: 40px; height: 40px; border-radius: 50%;">` : ""}
          <div>
            <strong>${item.author}</strong>
            ${item.role ? `<span style="opacity: 0.6;">, ${item.role}</span>` : ""}
          </div>
        </div>
      </div>
    `,
      )
      .join("");

    return `
    <section class="section" style="background: rgba(255,255,255,0.02);">
      <div class="container">
        ${c.title ? `<h2 style="text-align: center; margin-bottom: 2rem;">${c.title}</h2>` : ""}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem;">
          ${items}
        </div>
      </div>
    </section>`;
  }

  private renderPricing(c: PricingComponent): string {
    const tiers = c.tiers
      .map(
        (tier) => `
      <div style="padding: 2rem; background: ${tier.highlighted ? "linear-gradient(135deg, rgba(212,175,55,0.1), rgba(0,0,0,0.5))" : "rgba(255,255,255,0.05)"}; border-radius: 0.75rem; border: ${tier.highlighted ? "2px solid var(--color-primary)" : "1px solid rgba(255,255,255,0.1)"}; position: relative;">
        ${tier.badge ? `<span style="position: absolute; top: -10px; right: 1rem; background: var(--color-primary); color: var(--color-background); padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;">${tier.badge}</span>` : ""}
        <h3>${tier.name}</h3>
        <div style="margin: 1rem 0;">
          <span style="font-size: 2.5rem; font-weight: 700;">${tier.price}</span>
          ${tier.period ? `<span style="opacity: 0.6;">${tier.period}</span>` : ""}
        </div>
        ${tier.description ? `<p style="opacity: 0.7; margin-bottom: 1.5rem;">${tier.description}</p>` : ""}
        <ul style="list-style: none; margin-bottom: 1.5rem;">
          ${tier.features.map((f) => `<li style="padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.05);">✓ ${f}</li>`).join("")}
        </ul>
        <a href="${tier.ctaUrl}" class="btn ${tier.highlighted ? "btn-gradient" : "btn-primary"}" style="width: 100%; text-align: center;">${tier.ctaText}</a>
      </div>
    `,
      )
      .join("");

    return `
    <section class="section">
      <div class="container">
        ${c.title ? `<h2 style="text-align: center;">${c.title}</h2>` : ""}
        ${c.subtitle ? `<p style="text-align: center; opacity: 0.7; margin-bottom: 2rem;">${c.subtitle}</p>` : ""}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; max-width: 1000px; margin: 0 auto;">
          ${tiers}
        </div>
      </div>
    </section>`;
  }

  private renderCta(c: CtaComponent): string {
    const bgStyle = c.backgroundImage
      ? `background-image: url('${c.backgroundImage}'); background-size: cover;`
      : c.backgroundColor
        ? `background-color: ${c.backgroundColor};`
        : "background: linear-gradient(135deg, rgba(212,175,55,0.1), rgba(0,0,0,0.8));";

    return `
    <section class="section" style="${bgStyle}; padding: 4rem 0; text-align: center;">
      <div class="container">
        <h2 style="margin-bottom: 0.5rem;">${c.headline}</h2>
        ${c.subheadline ? `<p style="opacity: 0.8; margin-bottom: 2rem;">${c.subheadline}</p>` : ""}
        <a href="${c.buttonUrl}" class="btn btn-${c.buttonStyle}">${c.buttonText}</a>
      </div>
    </section>`;
  }

  private renderStats(c: StatsComponent): string {
    const items = c.items
      .map(
        (item) => `
      <div style="text-align: center; padding: 1rem;">
        <div style="font-size: 2.5rem; font-weight: 700; color: var(--color-primary);">${item.prefix || ""}${item.value}${item.suffix || ""}</div>
        <div style="opacity: 0.7; text-transform: uppercase; letter-spacing: 0.05em; font-size: 0.875rem;">${item.label}</div>
      </div>
    `,
      )
      .join("");

    const style =
      c.style === "horizontal"
        ? "display: flex; justify-content: center; gap: 3rem; flex-wrap: wrap;"
        : "display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem;";

    return `
    <section class="section" style="background: rgba(255,255,255,0.02);">
      <div class="container">
        ${c.title ? `<h2 style="text-align: center; margin-bottom: 2rem;">${c.title}</h2>` : ""}
        <div style="${style}">
          ${items}
        </div>
      </div>
    </section>`;
  }

  private renderFaq(c: FaqComponent): string {
    const items = c.items
      .map(
        (item) => `
      <details style="padding: 1rem; background: rgba(255,255,255,0.05); border-radius: 0.5rem; margin-bottom: 0.5rem;">
        <summary style="cursor: pointer; font-weight: 600;">${item.question}</summary>
        <p style="margin-top: 1rem; opacity: 0.8;">${item.answer}</p>
      </details>
    `,
      )
      .join("");

    return `
    <section class="section">
      <div class="container" style="max-width: 800px;">
        ${c.title ? `<h2 style="text-align: center; margin-bottom: 2rem;">${c.title}</h2>` : ""}
        ${items}
      </div>
    </section>`;
  }

  private renderFooter(c: FooterComponent): string {
    const columns = c.columns
      .map(
        (col) => `
      <div>
        <h4 style="margin-bottom: 1rem; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6;">${col.title}</h4>
        <ul style="list-style: none;">
          ${col.links.map((link) => `<li style="margin-bottom: 0.5rem;"><a href="${link.url}" style="color: var(--color-text); text-decoration: none; opacity: 0.8;">${link.label}</a></li>`).join("")}
        </ul>
      </div>
    `,
      )
      .join("");

    return `
    <footer style="background: rgba(0,0,0,0.5); padding: 3rem 0 1.5rem;">
      <div class="container">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 2rem; margin-bottom: 2rem;">
          ${columns}
        </div>
        ${c.copyright ? `<div style="text-align: center; opacity: 0.5; font-size: 0.875rem; padding-top: 1.5rem; border-top: 1px solid rgba(255,255,255,0.1);">${c.copyright}</div>` : ""}
      </div>
    </footer>`;
  }

  // ── Helpers ──────────────────────────────────────────────────

  private generateSlug(name: string): string {
    let slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Check uniqueness
    let candidate = slug;
    let counter = 1;
    while (Array.from(pages.values()).some((p) => p.slug === candidate)) {
      candidate = `${slug}-${counter}`;
      counter++;
    }

    return candidate;
  }
}

// Singleton instance
let storeInstance: LandingPagesStore | null = null;

export function getLandingPagesStore(): LandingPagesStore {
  if (!storeInstance) {
    storeInstance = new LandingPagesStore();
  }
  return storeInstance;
}

export function resetLandingPagesStore(): void {
  storeInstance = null;
}
