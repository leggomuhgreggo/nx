import { sync } from 'glob';
import { renameSync, readFileSync } from 'fs-extra';

// Vite cannot process JSX like <div> or <Header> unless the file is named .jsx or .tsx
export function renameJsToJsx(appName: string, isStandalone: boolean) {
  const files = sync(
    isStandalone ? 'src/**/*.js' : `apps/${appName}/src/**/*.js`
  );

  files.forEach((file) => {
    const content = readFileSync(file).toString();
    // Try to detect JSX before renaming to .jsx
    // Files like setupTests.js from CRA should not be renamed
    if (/<[a-zA-Z0-9]+/.test(content)) {
      renameSync(file, `${file}x`);
    }
  });
}
