import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir, hostname} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {captureContext, repositoryIdentifier} from '../scripts/local-context.mjs';

test('remote context strips credentials, rejects local paths, and separates detached branch', t=>{
  assert.equal(repositoryIdentifier('https://user:password@example.test/team/app.git?token=secret#fragment'),'example.test/team/app');
  assert.equal(repositoryIdentifier('git@example.test:team/app.git'),'example.test/team/app');
  for(const remote of ['/private/local/app','file:///private/local/app','invalid','https://example.test/team/with%20space'])assert.equal(repositoryIdentifier(remote),null);
  const dir=mkdtempSync(join(tmpdir(),'hub-context-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const git=args=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  git(['init','--initial-branch=feature/example']);git(['remote','add','origin','git@example.test:team/app.git']);
  git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.test','commit','--allow-empty','-m','Synthetic context']);
  const context=captureContext(dir);
  assert.equal(context.machine,hostname().toLowerCase().replace(/\.$/u,''));
  assert.deepEqual(context.workContext,{repository:'example.test/team/app',branch:'feature/example',commit:git(['rev-parse','HEAD'])});
  git(['checkout','--detach']);assert.equal(captureContext(dir).workContext.branch,null);
  git(['remote','set-url','origin','/private/local/app']);assert.equal(captureContext(dir).workContext,null);
  assert.equal(Object.hasOwn(context,'environment'),false);
});
