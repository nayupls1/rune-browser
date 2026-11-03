// Preset templates are imported as text (`with { type: "text" }`).
declare module "*.tpl" {
  const text: string;
  export default text;
}
