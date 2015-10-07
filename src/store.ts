import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { Promise, nfcall, resolve, reject, ninvoke } from 'q';
import { home } from 'osenv';
import { read, getGalleryAPI, getRawGalleryAPI } from './util';
import { validatePublisher } from './validation';

const storePath = path.join(home(), '.vsce');

export interface IPublisher {
	name: string;
	pat: string;
}

export interface IStore {
	publishers: IPublisher[];
}

export interface IGetOptions {
	promptToOverwrite?: boolean;
	promptIfMissing?: boolean;
}

function load(): Promise<IStore> {
	return nfcall<string>(fs.readFile, storePath, 'utf8')
		.catch<string>(err => err.code !== 'ENOENT' ? reject(err) : resolve('{}'))
		.then<IStore>(rawStore => {
			try {
				return resolve(JSON.parse(rawStore));
			} catch (e) {
				return reject(`Error parsing store: ${ storePath }`);
			}
		})
		.then(store => {
			store.publishers = store.publishers || [];
			return resolve(store);
		});
}

function save(store: IStore): Promise<IStore> {
	return nfcall<void>(fs.writeFile, storePath, JSON.stringify(store))
		.then(() => {
			if (process.platform !== 'win32') {
				return resolve(null);
			}
			
			return nfcall(exec, `attrib +H ${ storePath }`);
		})
		.then(() => store);
}

function addPublisherToStore(store: IStore, publisher: IPublisher): Promise<IPublisher> {
	store.publishers = [...store.publishers.filter(p => p.name !== publisher.name), publisher];
	return save(store).then(() => publisher);
}

function removePublisherFromStore(store: IStore, publisherName: string): Promise<any> {
	store.publishers = store.publishers.filter(p => p.name !== publisherName);
	return save(store);
}

function requestPAT(store: IStore, publisherName: string): Promise<IPublisher> {
	return read(`Personal Access Token for publisher '${ publisherName }':`, { silent: true, replace: '*' })
		.then(pat => {
			const api = getGalleryAPI(pat);
			
			return api.getPublisher(publisherName).then(p => {
				console.log(`Authentication successful. Found publisher '${ p.displayName }'.`);
				return pat;
			});
		})
		.then(pat => addPublisherToStore(store, { name: publisherName, pat }));
}

export function getPublisher(publisherName: string): Promise<IPublisher> {
	validatePublisher(publisherName);
	
	return load().then(store => {
		const publisher = store.publishers.filter(p => p.name === publisherName)[0];
		return publisher ? resolve(publisher) : requestPAT(store, publisherName);
	});
}

function loginPublisher(publisherName: string): Promise<IPublisher> {
	validatePublisher(publisherName);
	
	return load()
		.then<IStore>(store => {
			const publisher = store.publishers.filter(p => p.name === publisherName)[0];
			
			if (publisher) {
				console.log(`Publisher '${ publisherName }' is already known`);
				return read('Do you want to overwrite its PAT? [y/N] ')
					.then(answer => /^y$/i.test(answer) ? store : reject('Aborted'));
			}
			
			return resolve(store);
		})
		.then(store => requestPAT(store, publisherName));
}

function logoutPublisher(publisherName: string): Promise<any> {
	validatePublisher(publisherName);
	
	return load().then(store => {
		const publisher = store.publishers.filter(p => p.name === publisherName)[0];
		
		if (!publisher) {
			return reject(`Unknown publisher '${ publisherName }'`);
		}
		
		return removePublisherFromStore(store, publisherName);
	});
}

function createPublisher(publisherName: string): Promise<any> {
	return read(`Publisher human-friendly name: `, { default: publisherName }).then(displayName => {
		return read(`Personal Access Token:`, { silent: true, replace: '*' })
			.then(pat => {
				const api = getGalleryAPI(pat);
				const raw = {
					publisherName,
					displayName,
					extensions: [],
					flags: null,
					lastUpdated: null,
					longDescription: '',
					publisherId: null,
					shortDescription: ''
				};
				
				return api.createPublisher(raw)
					.then(() => ({ name: publisherName, pat }));
			})
			.then(publisher => load().then(store => addPublisherToStore(store, publisher)));
	})
	.then(() => console.log(`Successfully created publisher '${ publisherName }'.`));
}

function deletePublisher(publisherName: string): Promise<any> {
	return getPublisher(publisherName).then(({ pat }) => {
		return read(`This will FOREVER delete '${ publisherName }'! Are you sure? [y/N] `)
			.then(answer => /^y$/i.test(answer) ? null : reject('Aborted'))
			.then(() => ninvoke(getRawGalleryAPI(pat), 'deletePublisher', publisherName))
			.then(() => load().then(store => removePublisherFromStore(store, publisherName)))
			.then(() => console.log(`Successfully deleted publisher '${ publisherName }'.`));
	});
}

function listPublishers(): Promise<IPublisher[]> {
	return load().then(store => store.publishers);
}

export function publisher(action: string, publisherName: string): Promise<any> {
	switch (action) {
		case 'create': return createPublisher(publisherName);
		case 'delete': return deletePublisher(publisherName);
		case 'login': return loginPublisher(publisherName);
		case 'logout': return logoutPublisher(publisherName);
		default: return listPublishers().then(publishers => publishers.forEach(p => console.log(p.name)));
	}
}