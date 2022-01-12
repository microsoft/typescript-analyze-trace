import simplify = require("./simplify-type");

function getTypeTree(types: readonly object[], id: number): object {
    const tree = {};
    addTypeToTree(tree, id, []);
    return tree;

    function addTypeToTree(tree: {}, id: any, ancestorIds: any[]): void {
        if (typeof id !== "number") return;
        const type = simplify(types[id - 1]);
        if (!type) return;

        const children = {};

        // If there's a cycle, suppress the children, but not the type itself
        if (ancestorIds.indexOf(id) < 0) {
            ancestorIds.push(id);

            for (const prop in type) {
                if (prop.match(/type/i)) {
                    if (Array.isArray(type[prop])) {
                        for (const t of type[prop]) {
                            addTypeToTree(children, t, ancestorIds);
                        }
                    }
                    else {
                        addTypeToTree(children, type[prop], ancestorIds);
                    }
                }
            }

            ancestorIds.pop();
        }

        tree[JSON.stringify(type)] = children;
    }
}

export = getTypeTree;