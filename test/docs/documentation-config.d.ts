declare module "../../docs/shared/documentation-config.js" {
  export interface FileItem {
    name: string;
    path: string;
    type: "file" | "directory";
    children?: FileItem[];
    tags?: string[];
  }

  export const documentationTree: FileItem[];
}