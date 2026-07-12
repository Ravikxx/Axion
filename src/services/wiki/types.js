// Represents a single wiki page or source note
export class WikiPage {
  constructor({ title, path, summary = '', excerpt = '', sourcePath = '', tags = [], createdAt, updatedAt }) {
    this.title = title || 'Untitled';
    this.path = path;
    this.summary = summary;
    this.excerpt = excerpt;
    this.sourcePath = sourcePath;
    this.tags = tags;
    this.createdAt = createdAt || new Date().toISOString();
    this.updatedAt = updatedAt || this.createdAt;
  }
}

export class ConventionEntry {
  constructor({ file, type, value, description = '' }) {
    this.file = file;
    this.type = type;
    this.value = value;
    this.description = description;
  }
}

export class ProjectIdentity {
  constructor({ primaryLanguages = [], isMonorepo = false, mainBranch = 'main', packageManager = '' } = {}) {
    this.primaryLanguages = primaryLanguages;
    this.isMonorepo = isMonorepo;
    this.mainBranch = mainBranch;
    this.packageManager = packageManager;
  }
}
