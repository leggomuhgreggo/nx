import { type Compiler, sources, type WebpackPluginInstance } from 'webpack';
import {
  ExecutorContext,
  type ProjectGraph,
  serializeJson,
  createPackageJson,
  createLockFile,
} from '@nrwl/devkit';
import {
  getHelperDependenciesFromProjectGraph,
  HelperDependency,
} from '@nrwl/js/src/utils/compiler-helper-dependency';
import { readTsConfig } from '@nrwl/workspace/src/utilities/typescript';

import { NormalizedWebpackExecutorOptions } from '../executors/webpack/schema';
import { getLockFileName } from 'nx/src/lock-file/lock-file';

export class GeneratePackageJsonWebpackPlugin implements WebpackPluginInstance {
  private readonly projectGraph: ProjectGraph;

  constructor(
    private readonly context: ExecutorContext,
    private readonly options: NormalizedWebpackExecutorOptions
  ) {
    this.projectGraph = context.projectGraph;
  }

  apply(compiler: Compiler): void {
    const pluginName = this.constructor.name;

    compiler.hooks.thisCompilation.tap(pluginName, (compilation) => {
      compilation.hooks.processAssets.tap(
        {
          name: 'nx-generate-package-json-plugin',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          const helperDependencies = getHelperDependenciesFromProjectGraph(
            this.context.root,
            this.context.projectName,
            this.projectGraph
          );

          const importHelpers = !!readTsConfig(this.options.tsConfig).options
            .importHelpers;
          const shouldAddHelperDependency =
            importHelpers &&
            helperDependencies.every(
              (dep) => dep.target !== HelperDependency.tsc
            );

          if (shouldAddHelperDependency) {
            helperDependencies.push({
              type: 'static',
              source: this.context.projectName,
              target: HelperDependency.tsc,
            });
          }

          if (helperDependencies.length > 0) {
            this.projectGraph.dependencies[this.context.projectName] =
              this.projectGraph.dependencies[this.context.projectName].concat(
                helperDependencies
              );
          }

          const packageJson = createPackageJson(
            this.context.projectName,
            this.projectGraph,
            { root: this.context.root, isProduction: true }
          );
          packageJson.main = packageJson.main ?? this.options.outputFileName;

          compilation.emitAsset(
            'package.json',
            new sources.RawSource(serializeJson(packageJson))
          );
          compilation.emitAsset(
            getLockFileName(),
            new sources.RawSource(createLockFile(packageJson))
          );
        }
      );
    });
  }
}
