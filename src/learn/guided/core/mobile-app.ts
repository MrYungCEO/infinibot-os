import type { LearnTrack } from "../types.js";

/**
 * Mobile app & APK: the Mobile page (ui/src/ui/views/mobile.ts: APK card,
 * Dev client (Metro), Build the app, Web Preview), Setup › Install & Connect
 * (the pairing QR), and deep links (docs/mobile/DEEP-LINKS.md,
 * docs/mobile/ANDROID-APK.md).
 *
 * Never starts Metro or a build, never creates a download link: those are
 * explain-only steps.
 */
export const track: LearnTrack = {
  id: "mobile-app",
  title: "Mobile app & APK",
  summary:
    "Put InfiniBot on your phone: install the Android app, connect it to your gateway, and follow links from alerts straight to the right screen.",
  overview: [
    "The InfiniBot mobile app connects to the same gateway as this web UI, so your chats, agents, approvals and plugins come with you.",
    "",
    "This track covers:",
    "- **The Mobile page.** Download the Android APK straight from your gateway (no Play Store), run a development build against Metro, or build and sign the app yourself.",
    "- **Connecting.** In the app, choose **Self-hosted gateway** and enter your gateway URL and password, or choose **InfiniBot Cloud** and sign in. Setup › **Install & Connect** shows a QR code that carries the same details.",
    "- **Deep links.** Every alert carries an `infinibot://…` link (or an `https://…/m/…` opener for Telegram) that opens the right screen in the app, or the web UI when the app isn't installed.",
    "- **Learn on the go.** `infinibot://learn/<trackId>` opens a Learn track on your phone, and your progress follows you.",
  ].join("\n"),
  category: "Foundations",
  level: "intermediate",
  certRequired: true,
  order: 95,
  estMinutes: 12,
  routes: ["/mobile"],
  signals: ["mobile", "mobilepage"],
  badge: { id: "mobile-app", label: "Pocket Operator", icon: "📱" },
  walkthroughs: [
    {
      id: "install-apk",
      title: "Install the Android app",
      summary: "Get the APK from your own gateway and connect the app to it.",
      estMinutes: 3,
      steps: [
        {
          id: "mobile-page",
          title: "The Mobile page",
          body: "Everything for getting InfiniBot onto a phone lives here: the Android APK, a development client, and instructions for building the app yourself.",
          route: "/mobile",
          target: "learn:mobile-header",
          placement: "bottom",
        },
        {
          id: "apk-card",
          title: "Android app (APK)",
          body: "Once an APK is published on this gateway, this card shows its version, a **Download APK** button and a QR code. Until then it shows the one command that publishes one.",
          target: "learn:mobile-apk",
          placement: "bottom",
        },
        {
          id: "qr-link",
          title: "Download on your phone",
          body: "Scan the QR with your phone to download the APK. The link is signed, works for that one file only, and expires after 10 minutes. **New link** makes a fresh one.",
          target: "learn:mobile-apk",
          practice: {
            mode: "explain",
            note: "This tour doesn't create a download link. The QR appears only after an APK is published with scripts/mobile-apk-publish.mjs.",
          },
        },
        {
          id: "install",
          title: "Install and connect",
          body: "Allow **Install unknown apps** for your browser when Android asks, then open the file and tap Install. In the app, pick **Self-hosted gateway** and enter this gateway's URL and password, or pick **InfiniBot Cloud** and sign in.",
          target: "learn:mobile-apk",
        },
      ],
    },
    {
      id: "pair-a-device",
      title: "Pair with a QR code",
      summary: "Setup › Install & Connect: the connection details and QR code for your devices.",
      estMinutes: 2,
      steps: [
        {
          id: "open-install",
          title: "Install & Connect",
          body: "Click **Install & Connect** in the Setup menu.",
          route: "/setup",
          target: "learn:setup-nav-install",
          action: { kind: "click" },
          waitMs: 12000,
        },
        {
          id: "connection",
          title: "Your connection details",
          body: "The gateway address, its token (masked) and a short connection code. The QR code encodes an `infinibot://connect?url=…&token=…` link the app reads to fill in the connection for you.",
          target: "learn:setup-connect-hero",
          placement: "bottom",
        },
        {
          id: "treat-as-password",
          title: "Treat the QR like a password",
          body: "The QR and **Copy All** carry your gateway's token. Show them only to your own devices, and rotate the token if one leaks.",
          target: "learn:setup-connect-hero",
          practice: {
            mode: "explain",
            note: "Nothing is copied or shared in this tour.",
          },
        },
      ],
    },
    {
      id: "dev-client",
      title: "Run a development build",
      summary: "The Dev client (Metro) tab: connection mode, gateway URL and the Metro QR.",
      estMinutes: 3,
      steps: [
        {
          id: "tabs",
          title: "Three ways in",
          body: "**Dev client (Metro)** runs the app's JavaScript from this machine. **Build the app** signs your own APK or IPA. **Web Preview** runs the mobile app in your browser. Click **Dev client (Metro)**.",
          route: "/mobile",
          target: "learn:mobile-tab-expo",
          action: { kind: "click" },
        },
        {
          id: "mode",
          title: "Pick a connection mode",
          body: "**Tunnel** works across networks but is slower. **LAN** is fast on the same Wi-Fi. **Localhost** is for a simulator on this machine. **Tailscale** works across your tailnet.",
          target: "learn:mobile-connection-mode",
        },
        {
          id: "gateway-url",
          title: "The gateway URL",
          body: "Pre-filled from this gateway's WebSocket address. If your phone is on another network, paste a public URL, such as a Cloudflare Tunnel or Tailscale Serve address.",
          target: "learn:mobile-gateway-url",
        },
        {
          id: "start-metro",
          title: "Start Metro and scan",
          body: "**Start Expo dev server** starts Metro and shows a QR. Scan it from the **InfiniBot dev client**. Expo Go from the app stores won't load this app, because it uses native modules.",
          target: "learn:mobile-start-metro",
          practice: {
            mode: "explain",
            note: "This tour doesn't start Metro. It runs a long-lived process on the gateway machine.",
          },
        },
      ],
    },
    {
      id: "build-and-preview",
      title: "Build it yourself, or preview it",
      summary: "Where the build instructions live, and the in-browser preview of the mobile app.",
      estMinutes: 2,
      steps: [
        {
          id: "open-build",
          title: "Build the app",
          body: "Click **Build the app**.",
          route: "/mobile",
          target: "learn:mobile-tab-build",
          action: { kind: "click" },
        },
        {
          id: "build",
          title: "Android and iOS builds",
          body: "Android: build locally with Gradle or in Expo's cloud with EAS, then publish the APK so it appears in the card above. iOS: EAS signs an IPA with your Apple account.",
          target: "learn:mobile-build-intro",
          practice: {
            mode: "explain",
            note: "Builds are never started from a tour. Cloud builds can use paid EAS build minutes.",
          },
        },
        {
          id: "open-web",
          title: "Web Preview",
          body: "Click **Web Preview**.",
          target: "learn:mobile-tab-web",
          action: { kind: "click" },
        },
        {
          id: "web",
          title: "The app in your browser",
          body: "This is the web build of the mobile app shipped with your install. It's a quick way to try a screen without a phone.",
          target: ["learn:mobile-web-preview", "learn:mobile-tabs"],
        },
      ],
    },
    {
      id: "deep-links",
      title: "Deep links and alerts",
      summary:
        "How a tap on an alert lands on the right screen, and how to open Learn on your phone.",
      estMinutes: 2,
      steps: [
        {
          id: "alerts",
          title: "Alerts carry a link",
          body: "Every notification, push alert, Telegram message and proactive overlay carries a deep link. Tap it and the right screen opens: an approval, a run, a task or a plugin page.",
          route: "/",
          target: ["button.notif-bell", ".topbar"],
        },
        {
          id: "two-forms",
          title: "Two forms, one path",
          body: "The app scheme looks like `infinibot://approvals/<id>`. Where an https link is needed, as in Telegram, it's `https://<your-host>/m/approvals/<id>`, which opens the app on a phone or the web UI on a desktop.",
          target: "main.content",
          placement: "center",
        },
        {
          id: "learn-on-phone",
          title: "Learn on your phone",
          body: "`infinibot://learn/<trackId>` opens a track in the app. Add `/<walkthroughId>` to start a tour straight away, for example `infinibot://learn/mobile-app/deep-links`.",
          route: "/learn",
          target: ["learn:learn-page", "main.content"],
          placement: "center",
        },
      ],
    },
  ],
  quiz: [
    {
      id: "apk-source",
      prompt: "Where does the Android APK on the Mobile page come from?",
      options: [
        "The Google Play Store",
        "Your own gateway, after an APK is published to it",
        "It's generated on every page load",
        "Only from InfiniBot Cloud",
      ],
      answer: 1,
      explain:
        "Publish an APK with scripts/mobile-apk-publish.mjs and the gateway serves it with a download button and a QR code.",
    },
    {
      id: "expo-go",
      prompt: "Why can't you use Expo Go from the app store to run the development build?",
      options: [
        "Expo Go is paid",
        "The app uses native modules (LiveKit voice, WebRTC), so it needs the InfiniBot dev client",
        "Metro only works on iOS",
        "Expo Go is blocked by the gateway password",
      ],
      answer: 1,
      explain:
        "The Dev client tab says so: install the InfiniBot development build once, then Metro serves the JavaScript.",
    },
    {
      id: "learn-link",
      prompt: "Which link opens the Mobile app Learn track on your phone?",
      options: [
        "infinibot://learn/mobile-app",
        "infinibot://settings/learn",
        "https://play.google.com/learn",
        "mobile://tour",
      ],
      answer: 0,
      explain:
        "infinibot://learn/<trackId> opens a track. Add /<walkthroughId> to start a walkthrough too.",
    },
    {
      id: "qr-secret",
      prompt: "What should you keep in mind about the Install & Connect QR code?",
      options: [
        "It's public and safe to post",
        "It carries your gateway's token, so treat it like a password",
        "It only works once",
        "It contains your chat history",
      ],
      answer: 1,
      explain: "The QR encodes infinibot://connect with the gateway URL and token.",
    },
  ],
};
