import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
export class SqliteD1 {
  constructor(path=':memory:'){this.database=new DatabaseSync(path);const root=new URL('../migrations/',import.meta.url);for(const file of readdirSync(root).filter(name=>/^\d+.*\.sql$/u.test(name)).sort())this.database.exec(readFileSync(new URL(file,root),'utf8'));}
  withSession(){return this;}
  prepare(query){const db=this.database;let parameters=[];const statement={
    bind(...values){parameters=values;return statement;},
    async first(column){const row=db.prepare(query).get(...parameters);return column?row?.[column]??null:row??null;},
    async all(){return {success:true,results:db.prepare(query).all(...parameters)};},
    async run(){const result=db.prepare(query).run(...parameters);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};},
  };return statement;}
  async batch(statements){this.database.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());this.database.exec('COMMIT');return results;}catch(error){this.database.exec('ROLLBACK');throw error;}}
  close(){this.database.close();}
}
