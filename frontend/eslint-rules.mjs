const jsxContainers = new Set(['JSXElement', 'JSXFragment']);

export const oneJsxTagPerLine = {
  meta: {
    type: 'layout',
    schema: [],
    messages: { sharedLine: 'Move this JSX tag to a line without another tag in the same JSX tree.' },
  },
  create(context) {
    const { sourceCode } = context;
    const trees = new Map();

    function recordTag(tag) {
      const root = sourceCode.getAncestors(tag).find(node => jsxContainers.has(node.type));
      const markers = trees.get(root) ?? [];
      markers.push({ tag, token: sourceCode.getFirstToken(tag) }, { tag, token: sourceCode.getLastToken(tag) });
      trees.set(root, markers);
    }

    return {
      JSXOpeningElement: recordTag,
      JSXClosingElement: recordTag,
      JSXOpeningFragment: recordTag,
      JSXClosingFragment: recordTag,
      'Program:exit'() {
        for (const markers of trees.values()) {
          const owners = new Map();
          markers.sort((left, right) => left.token.range[0] - right.token.range[0]);
          for (const { tag, token } of markers) {
            const line = token.loc.start.line;
            const owner = owners.get(line);
            if (owner && owner !== tag.parent) {
              context.report({ node: tag, loc: token.loc, messageId: 'sharedLine' });
            }
            owners.set(line, tag.parent);
          }
        }
      },
    };
  },
};
