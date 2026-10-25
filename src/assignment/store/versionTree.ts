// The part of a project's versions that is plain data: which version was made from which, what the stage draws for each, what an edit
// by words acts on. The rules live in shared/versionTree.ts (no React and no store, so the Node tests import them as they are); this
// file keeps the path the stores and components import them from.

export * from "@/assignment/shared/versionTree";
