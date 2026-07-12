import {
  getAllCredentials,
  getCredentials,
  getCredential,
  createCredential,
  updateCredential,
  deleteCredential,
  deleteCredentials,
} from './credentialStore.js';

export class CredentialService {
  static listAll() {
    return getAllCredentials();
  }

  static list(integration) {
    return getCredentials(integration);
  }

  static get(id) {
    return getCredential(id);
  }

  static create(integration, value, label) {
    return createCredential(integration, value, label);
  }

  static update(id, updates) {
    return updateCredential(id, updates);
  }

  static remove(id) {
    return deleteCredential(id);
  }

  static removeAll(integration) {
    return deleteCredentials(integration);
  }

  static resolve(integration) {
    const creds = getCredentials(integration);
    if (!creds.length) return null;
    return creds[0].value;
  }
}
