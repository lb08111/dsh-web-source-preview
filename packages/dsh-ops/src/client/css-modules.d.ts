/** CSS Modules: the bundler inlines the stylesheet and exports its class map. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
