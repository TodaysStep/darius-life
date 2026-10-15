import { JSDOM } from "jsdom";

export const SUPPORT_PATH = "dist/buymecoffee/index.html";
export const SUPPORT_RECIPIENT = "sms:+14155335621";

// The founder requested publication of this personal Apple Cash page. Only its
// single Messages destination is public; other phone/address occurrences fail.
export function privacyScanText(file, text) {
  if (file !== SUPPORT_PATH) return text;
  const dom = new JSDOM(text);
  const links = dom.window.document.querySelectorAll("a.support");
  if (links.length !== 1 || links[0].getAttribute("href") !== SUPPORT_RECIPIENT) return text;
  links[0].removeAttribute("href");
  return dom.serialize();
}
