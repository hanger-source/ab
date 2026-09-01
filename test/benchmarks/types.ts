export type BenchmarkSuite =
  | "miniwob++"
  | "webarena-verified-hard"
  | "visualwebarena"
  | "assistantbench-validation";

export type BenchmarkTask = {
  suite: BenchmarkSuite;
  id: string;
  intent: string;
  sites: readonly string[];
  startUrls: readonly string[];
  sourceFile: string;
  inputImages: readonly string[];
  difficulty: {
    reasoning?: string;
    visual?: string;
    overall?: string;
  };
  evaluation: unknown;
};

export type BenchmarkDoctorCheck = {
  name: string;
  status: "ready" | "blocked";
  detail: string;
};

export type BenchmarkDoctorReport = {
  ready: boolean;
  checks: readonly BenchmarkDoctorCheck[];
};

export type CommandResult = {
  command: readonly string[];
  exitCode: number;
  stdout: string;
  stderr: string;
};
