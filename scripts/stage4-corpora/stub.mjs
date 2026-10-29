// Stub corpus: three pure classifyCommand calls. Proves the harness machinery (coverage pin, compare, self-test); Tasks 8-10 add the real corpora.
const COMMANDS = ["ls", "cat README.md", "pwd"];

export default {
  name: "stub",
  pairs: [["s3", "new"], ["s4a", "new"]],
  min: { items: 3, branches: ["plain"] },
  async load() { return COMMANDS.map((command, i) => ({ key: `stub#${i + 1}`, tags: ["plain"], command })); },
  async project(d, item) {
    if (!d.classifyCommand) throw new Error(`${d.dir} has no classifyCommand`);
    return { command: item.command, class: d.classifyCommand(item.command) };
  },
  required(d, item, proj) { if (proj.class.kind !== "plain") throw new Error(`${item.key}: expected plain, got ${proj.class.kind}`); }
};
