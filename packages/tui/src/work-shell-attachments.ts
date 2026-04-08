export type WorkShellImageAttachment = {
  readonly type: "image";
  readonly mimeType: string;
  readonly dataUrl: string;
  readonly path: string;
  readonly displayName: string;
};

function base64Name(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function detectTerminalInlineImageProtocol(env: NodeJS.ProcessEnv = process.env): "iterm" | "kitty" | undefined {
  if (env.TERM_PROGRAM === "iTerm.app") {
    return "iterm";
  }

  if (
    (env.TERM ?? "").includes("kitty") ||
    typeof env.KITTY_WINDOW_ID === "string" ||
    env.TERM_PROGRAM === "ghostty" ||
    env.TERM_PROGRAM === "WezTerm"
  ) {
    return "kitty";
  }

  return undefined;
}

export function formatAttachmentBadgeLine(attachments: readonly WorkShellImageAttachment[]): string {
  return `Attachments ${attachments.length} · ${attachments.map((attachment) => attachment.displayName).join(", ")}`;
}

export function buildAttachmentPreviewLines(attachments: readonly WorkShellImageAttachment[]): readonly string[] {
  return [
    formatAttachmentBadgeLine(attachments),
    ...attachments.slice(0, 3).map((attachment, index) => `${index + 1}. ${attachment.displayName} · ${attachment.mimeType}`),
  ];
}

export function formatInlineImageSupportLine(env: NodeJS.ProcessEnv = process.env): string {
  const protocol = detectTerminalInlineImageProtocol(env);
  if (protocol === "iterm") {
    return "iTerm inline preview paused while typing to prevent ghosting.";
  }
  if (protocol === "kitty") {
    return "Kitty inline preview paused while typing to prevent ghosting.";
  }
  return "Preview unavailable in this terminal.";
}

export function buildTerminalInlineImageSequence(
  attachment: WorkShellImageAttachment,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const payload = attachment.dataUrl.split(",", 2)[1] ?? "";
  if (!payload) {
    return undefined;
  }

  const protocol = detectTerminalInlineImageProtocol(env);
  if (protocol === "iterm") {
    return `\u001b]1337;File=name=${base64Name(attachment.displayName)};inline=1:${payload}\u0007`;
  }

  if (protocol === "kitty") {
    return `\u001b_Gf=100,a=T,t=d;${payload}\u001b\\`;
  }

  return undefined;
}
