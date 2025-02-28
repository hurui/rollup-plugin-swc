import type { Plugin } from 'rollup';

import { existsSync, statSync } from 'fs';
import { extname, resolve, dirname, join } from 'path';
import { createFilter, FilterPattern } from '@rollup/pluginutils';
import { Config as SwcConfig, JscTarget, transform as swcTransform, minify as swcMinify, JsMinifyOptions } from '@swc/core';
import deepmerge from 'deepmerge';

import { getOptions } from './options';

export type PluginOptions = {
  include?: FilterPattern
  exclude?: FilterPattern
  /**
   * Use given tsconfig file instead
   * Disable it by setting to `false`
   */
  tsconfig?: string | false
} & Pick<SwcConfig, Exclude<keyof SwcConfig, 'filename' & 'include' & 'exclude'>>;

const INCLUDE_REGEXP = /\.m?[jt]sx?$/;
const EXCLUDE_REGEXP = /node_modules/;

const ROLLUP_VIRTUAL_MODULE_IDENTIFIER = '\0';
const REGEXP_ROLLUP_VIRTUAL_MODULE_IDENTIFIER = /\0/gm;
// To prevent the line being escaped when trying to build rollup-plugin-swc using rollup-plugin-swc
// eslint-disable-next-line no-useless-concat
const ROLLUP_VIRTUAL_MODULE_ESCAPE_IDENTIFIER = '$_' + '_SECRET_ROLLUP_VIRTUAL_MODULE_ESCAPE_IDENTIFIER_' + 'DO_NOT_USE_OR_YOU_WILL_BE_FIRED_' + '_$';
const REGEXP_ROLLUP_VIRTUAL_MODULE_ESCAPE_IDENTIFIER = /\$__SECRET_ROLLUP_VIRTUAL_MODULE_ESCAPE_IDENTIFIER_DO_NOT_USE_OR_YOU_WILL_BE_FIRED__\$/gm;

const ACCEPTED_EXTENSIONS = ['.ts', '.mjs', '.js', '.tsx', '.jsx'];

const resolveFile = (resolved: string, index = false) => {
  for (const ext of ACCEPTED_EXTENSIONS) {
    const file = index ? join(resolved, `index${ext}`) : `${resolved}${ext}`;
    if (existsSync(file)) return file;
  }
  return null;
};

function swc(options: PluginOptions = {}): Plugin {
  const filter = createFilter(
    options.include || INCLUDE_REGEXP,
    options.exclude || EXCLUDE_REGEXP
  );

  return {
    name: 'swc',

    resolveId(importee, importer) {
      // ignore IDs with null character, these belong to other plugins
      if (importee.startsWith('\0')) {
        return null;
      }

      if (importer && importee[0] === '.') {
        const resolved = resolve(
          importer ? dirname(importer) : process.cwd(),
          importee
        );

        let file = resolveFile(resolved);
        if (file) return file;
        if (!file && existsSync(resolved) && statSync(resolved).isDirectory()) {
          file = resolveFile(resolved, true);
          if (file) return file;
        }
      }
    },

    async transform(code: string, id: string) {
      if (!filter(id)) {
        return null;
      }

      const ext = extname(id);

      if (!ACCEPTED_EXTENSIONS.includes(ext)) return null;

      const isTypeScript = ext === '.ts' || ext === '.tsx';
      const isTsx = ext === '.tsx';
      const isJsx = ext === '.jsx';

      const tsconfigOptions
        = options.tsconfig === false
          ? {}
          : await getOptions(dirname(id), options.tsconfig);

      const swcOptionsFromTsConfig: SwcConfig = {
        jsc: {
          externalHelpers: tsconfigOptions.importHelpers,
          parser: {
            syntax: isTypeScript ? 'typescript' : 'ecmascript',
            tsx: isTypeScript ? isTsx : undefined,
            jsx: !isTypeScript ? isJsx : undefined,
            decorators: tsconfigOptions.experimentalDecorators
          },
          transform: {
            decoratorMetadata: tsconfigOptions.emitDecoratorMetadata,
            react: {
              pragma: tsconfigOptions.jsxFactory,
              pragmaFrag: tsconfigOptions.jsxFragmentFactory
            }
          },
          target: tsconfigOptions.target?.toLowerCase() as JscTarget | undefined,
          baseUrl: tsconfigOptions.baseUrl,
          paths: tsconfigOptions.paths
        }
      };

      const swcOption = deepmerge.all([
        swcOptionsFromTsConfig,
        options,
        {
          filename: id,
          include: undefined, // Rollup's filter is not compatible with swc
          exclude: undefined,
          tsconfig: undefined, // swc has no tsconfig option
          minify: false // Disable minify on transform, do it on renderChunk
        }
      ]);

      /**
       * swc cannot transform module ids with "\0", which is the identifier of rollup virtual module
       *
       * FIXME: This is a temporary workaround, remove when swc fixes it (DO NOT FORGET TO BUMP PEER DEPS VERSION AS WELL!)
       *
       * @see https://rollupjs.org/guide/en/#conventions
       * @see https://github.com/rollup/plugins/blob/02fb349d315f0ffc55970fba5de20e23f8ead881/packages/commonjs/src/helpers.js#L15
       * @see https://github.com/SukkaW/rollup-plugin-swc/pull/1
       * @see https://github.com/swc-project/swc/issues/2853
       */
      const { code: transformedCode, ...rest } = await swcTransform(
        code.replace(
          REGEXP_ROLLUP_VIRTUAL_MODULE_IDENTIFIER,
          ROLLUP_VIRTUAL_MODULE_ESCAPE_IDENTIFIER
        ),
        swcOption
      );

      return {
        ...rest,
        code: transformedCode.replace(
          REGEXP_ROLLUP_VIRTUAL_MODULE_ESCAPE_IDENTIFIER,
          ROLLUP_VIRTUAL_MODULE_IDENTIFIER
        )
      };
    },

    renderChunk(code: string) {
      if (options.minify) {
        return swcMinify(code, options.jsc?.minify);
      }

      return null;
    }
  };
}

function minify(options: JsMinifyOptions = {}): Plugin {
  return {
    name: 'swc-minify',

    renderChunk(code: string) {
      return swcMinify(code, options);
    }
  };
}

function defineRollupSwcOption(option: PluginOptions) {
  return option;
}

function defineRollupSwcMinifyOption(option: JsMinifyOptions) {
  return option;
}

export default swc;
export { swc, defineRollupSwcOption, minify, defineRollupSwcMinifyOption };
