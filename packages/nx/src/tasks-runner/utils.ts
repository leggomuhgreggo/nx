import { output } from '../utils/output';
import { Workspaces } from '../config/workspaces';
import { mergeNpmScriptsWithTargets } from '../utils/project-graph-utils';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import {
  loadNxPlugins,
  mergePluginTargetsWithNxTargets,
} from '../utils/nx-plugin';
import { Task, TaskGraph } from '../config/task-graph';
import { ProjectGraph, ProjectGraphProjectNode } from '../config/project-graph';
import { TargetDependencyConfig } from '../config/workspace-json-project-json';
import { workspaceRoot } from '../utils/workspace-root';
import { NxJsonConfiguration } from '../config/nx-json';
import { joinPathFragments } from '../utils/path';
import { isRelativePath } from '../utils/fileutils';
import { serializeOverridesIntoCommandLine } from '../utils/serialize-overrides-into-command-line';

export function getCommandAsString(execCommand: string, task: Task) {
  const args = getPrintableCommandArgsForTask(task);
  return [execCommand, 'nx', ...args].join(' ').trim();
}

export function getDependencyConfigs(
  { project, target }: { project: string; target: string },
  defaultDependencyConfigs: Record<string, (TargetDependencyConfig | string)[]>,
  projectGraph: ProjectGraph
): TargetDependencyConfig[] | undefined {
  // DependencyConfigs configured in workspace.json override configurations at the root.
  const dependencyConfigs = expandDependencyConfigSyntaxSugar(
    projectGraph.nodes[project].data?.targets[target]?.dependsOn ??
      defaultDependencyConfigs[target] ??
      []
  );
  for (const dependencyConfig of dependencyConfigs) {
    if (
      dependencyConfig.projects !== 'dependencies' &&
      dependencyConfig.projects !== 'self'
    ) {
      output.error({
        title: `dependsOn is improperly configured for ${project}:${target}`,
        bodyLines: [
          `dependsOn.projects is "${dependencyConfig.projects}" but should be "self" or "dependencies"`,
        ],
      });
      process.exit(1);
    }
  }
  return dependencyConfigs;
}

function expandDependencyConfigSyntaxSugar(
  deps: (TargetDependencyConfig | string)[]
): TargetDependencyConfig[] {
  return deps.map((d) => {
    if (typeof d === 'string') {
      if (d.startsWith('^')) {
        return { projects: 'dependencies', target: d.substring(1) };
      } else {
        return { projects: 'self', target: d };
      }
    } else {
      return d;
    }
  });
}

export function getOutputs(
  p: Record<string, ProjectGraphProjectNode>,
  task: Task
) {
  return getOutputsForTargetAndConfiguration(task, p[task.target.project]);
}

class InvalidOutputsError extends Error {
  constructor(public outputs: string[], public invalidOutputs: Set<string>) {
    super(InvalidOutputsError.createMessage(invalidOutputs));
  }

  private static createMessage(invalidOutputs: Set<string>) {
    const invalidOutputsList =
      '\n - ' + Array.from(invalidOutputs).join('\n - ');
    return `The following outputs are invalid:${invalidOutputsList}\nPlease run "nx repair" to repair your configuration`;
  }
}

export function validateOutputs(outputs: string[]) {
  const invalidOutputs = new Set<string>();

  for (const output of outputs) {
    if (!/^{[\s\S]+}/.test(output)) {
      invalidOutputs.add(output);
    }
  }
  if (invalidOutputs.size > 0) {
    throw new InvalidOutputsError(outputs, invalidOutputs);
  }
}

export function transformLegacyOutputs(
  projectRoot: string,
  error: InvalidOutputsError
) {
  return error.outputs.map((output) => {
    if (!error.invalidOutputs.has(output)) {
      return output;
    }

    const relativePath = isRelativePath(output)
      ? output
      : relative(projectRoot, output);

    const isWithinProject = !relativePath.startsWith('..');
    return joinPathFragments(
      isWithinProject ? '{projectRoot}' : '{workspaceRoot}',
      isWithinProject ? relativePath : output
    );
  });
}

/**
 * Returns the list of outputs that will be cached.
 * @param task target + overrides
 * @param node ProjectGraphProjectNode object that the task runs against
 */
export function getOutputsForTargetAndConfiguration(
  task: Pick<Task, 'target' | 'overrides'>,
  node: ProjectGraphProjectNode
): string[] {
  const { target, configuration } = task.target;

  const targetConfiguration = node.data.targets[target];

  const options = {
    ...targetConfiguration.options,
    ...targetConfiguration?.configurations?.[configuration],
    ...task.overrides,
  };

  if (targetConfiguration?.outputs) {
    try {
      validateOutputs(targetConfiguration.outputs);
    } catch (error) {
      if (error instanceof InvalidOutputsError) {
        // TODO(v16): start warning for invalid outputs
        targetConfiguration.outputs = transformLegacyOutputs(
          node.data.root,
          error
        );
      } else {
        throw error;
      }
    }

    return targetConfiguration.outputs
      .map((output: string) => {
        return interpolate(output, {
          projectRoot: node.data.root,
          projectName: node.name,
          project: { ...node.data, name: node.name }, // this is legacy
          options,
        });
      })
      .filter((output) => !!output && !output.match(/{.*}/));
  }

  // Keep backwards compatibility in case `outputs` doesn't exist
  if (options.outputPath) {
    return Array.isArray(options.outputPath)
      ? options.outputPath
      : [options.outputPath];
  } else if (target === 'build' || target === 'prepare') {
    return [
      `dist/${node.data.root}`,
      `${node.data.root}/dist`,
      `${node.data.root}/build`,
      `${node.data.root}/public`,
    ];
  } else {
    return [];
  }
}

export function interpolate(template: string, data: any): string {
  if (template.includes('{workspaceRoot}', 1)) {
    throw new Error(
      `Output '${template}' is invalid. {workspaceRoot} can only be used at the beginning of the expression.`
    );
  }

  if (data.projectRoot == '.' && template.includes('{projectRoot}', 1)) {
    throw new Error(
      `Output '${template}' is invalid. When {projectRoot} is '.', it can only be used at the beginning of the expression.`
    );
  }

  let res = template.replace('{workspaceRoot}/', '');

  if (data.projectRoot == '.') {
    res = res.replace('{projectRoot}/', '');
  }

  return res.replace(/{([\s\S]+?)}/g, (match: string) => {
    let value = data;
    let path = match.slice(1, -1).trim().split('.');
    for (let idx = 0; idx < path.length; idx++) {
      if (!value[path[idx]]) {
        return match;
      }
      value = value[path[idx]];
    }
    return value;
  });
}

export function getExecutorNameForTask(
  task: Task,
  nxJson: NxJsonConfiguration,
  projectGraph: ProjectGraph
) {
  const project = projectGraph.nodes[task.target.project].data;

  const projectRoot = join(workspaceRoot, project.root);
  if (existsSync(join(projectRoot, 'package.json'))) {
    project.targets = mergeNpmScriptsWithTargets(projectRoot, project.targets);
  }
  project.targets = mergePluginTargetsWithNxTargets(
    project.root,
    project.targets,
    loadNxPlugins(nxJson.plugins)
  );

  return project.targets[task.target.target].executor;
}

export function getExecutorForTask(
  task: Task,
  workspace: Workspaces,
  projectGraph: ProjectGraph,
  nxJson: NxJsonConfiguration
) {
  const executor = getExecutorNameForTask(task, nxJson, projectGraph);
  const [nodeModule, executorName] = executor.split(':');

  return workspace.readExecutor(nodeModule, executorName);
}

export function getCustomHasher(
  task: Task,
  workspace: Workspaces,
  nxJson: NxJsonConfiguration,
  projectGraph: ProjectGraph
) {
  const factory = getExecutorForTask(
    task,
    workspace,
    projectGraph,
    nxJson
  ).hasherFactory;
  return factory ? factory() : null;
}

export function removeTasksFromTaskGraph(
  graph: TaskGraph,
  ids: string[]
): TaskGraph {
  const tasks = {};
  const dependencies = {};
  const removedSet = new Set(ids);
  for (let taskId of Object.keys(graph.tasks)) {
    if (!removedSet.has(taskId)) {
      tasks[taskId] = graph.tasks[taskId];
      dependencies[taskId] = graph.dependencies[taskId].filter(
        (depTaskId) => !removedSet.has(depTaskId)
      );
    }
  }
  return {
    tasks,
    dependencies: dependencies,
    roots: Object.keys(dependencies).filter(
      (k) => dependencies[k].length === 0
    ),
  };
}

export function calculateReverseDeps(
  taskGraph: TaskGraph
): Record<string, string[]> {
  const reverseTaskDeps: Record<string, string[]> = {};
  Object.keys(taskGraph.tasks).forEach((t) => {
    reverseTaskDeps[t] = [];
  });

  Object.keys(taskGraph.dependencies).forEach((taskId) => {
    taskGraph.dependencies[taskId].forEach((d) => {
      reverseTaskDeps[d].push(taskId);
    });
  });

  return reverseTaskDeps;
}

export function getCliPath() {
  return require.resolve(`../../bin/run-executor.js`);
}

export function getPrintableCommandArgsForTask(task: Task) {
  const args: string[] = task.overrides['__overrides_unparsed__'];

  const target = task.target.target.includes(':')
    ? `"${task.target.target}"`
    : task.target.target;

  const config = task.target.configuration
    ? `:${task.target.configuration}`
    : '';

  return ['run', `${task.target.project}:${target}${config}`, ...args];
}

export function getSerializedArgsForTask(task: Task, isVerbose: boolean) {
  return [
    JSON.stringify({
      targetDescription: task.target,
      overrides: task.overrides,
      isVerbose: isVerbose,
    }),
  ];
}

export function shouldStreamOutput(
  task: Task,
  initiatingProject: string | null,
  options: {
    cacheableOperations?: string[] | null;
    cacheableTargets?: string[] | null;
  }
): boolean {
  if (process.env.NX_STREAM_OUTPUT === 'true') return true;
  if (longRunningTask(task)) return true;
  if (task.target.project === initiatingProject) return true;
  return false;
}

export function isCacheableTask(
  task: Task,
  options: {
    cacheableOperations?: string[] | null;
    cacheableTargets?: string[] | null;
  }
): boolean {
  const cacheable = options.cacheableOperations || options.cacheableTargets;
  return (
    cacheable &&
    cacheable.indexOf(task.target.target) > -1 &&
    !longRunningTask(task)
  );
}

function longRunningTask(task: Task) {
  const t = task.target.target;
  return (
    (!!task.overrides['watch'] && task.overrides['watch'] !== 'false') ||
    t.endsWith(':watch') ||
    t.endsWith('-watch') ||
    t === 'serve' ||
    t === 'dev' ||
    t === 'start'
  );
}

// TODO: vsavkin remove when nx-cloud doesn't depend on it
export function unparse(options: Object): string[] {
  return serializeOverridesIntoCommandLine(options);
}
