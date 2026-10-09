/** A form field as text. A missing field or a file upload reads as "", never "[object File]". */
export function formText(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}
