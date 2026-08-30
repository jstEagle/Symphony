export * from "@symphony/protocol";
export * from "@symphony/workflow";

export type SymphonyPluginManifest = {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  entry: string;
  piCompatible?: boolean;
  description?: string;
  contributes?: {
    webEntry?: string;
    workflows?: string[];
    modelCatalogs?: string[];
  };
};
