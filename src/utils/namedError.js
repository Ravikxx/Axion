// NamedError — typed error factory with structured data fields.
//
// Usage:
//   const ToolError = NamedError.create('ToolExecutionError', { tool: 'string', message: 'string' });
//   throw new ToolError({ tool: 'read_file', message: 'not found' });
//
//   NamedError.hasName(err, 'ToolExecutionError')  // true
//   err.name                                       // 'ToolExecutionError'
//   err.data                                       // { tool: 'read_file', message: 'not found' }
//   err.toObject()                                 // { name: 'ToolExecutionError', data: {...} }

// Supported field types for validation:
//   'string'  — must be a string
//   'number'  — must be a number
//   'boolean' — must be a boolean
//   'object'  — must be a plain object
//   'any'     — no validation (default if type omitted)

const TYPE_VALIDATORS = {
  string:  (v) => typeof v === 'string',
  number:  (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
  object:  (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  any:     () => true,
};

export class NamedError extends Error {
  /**
   * Create a named error class with typed data fields.
   *
   * @param {string} name — error class name (becomes .name)
   * @param {Record<string, string|{type?: string, required?: boolean, default?: any}>} fields
   *   Each key is a field name. Value can be:
   *     - A type string ('string', 'number', 'boolean', 'object', 'any')
   *     - An object with { type, required, default }
   *   If a field is not provided and has no default, it is omitted from .data.
   *   If a field is required and missing, a TypeError is thrown at construction.
   *
   * @returns {NamedError} A subclass of NamedError with static helpers.
   */
  static create(name, fields = {}) {
    const fieldDefs = {};
    for (const [key, spec] of Object.entries(fields)) {
      if (typeof spec === 'string') {
        fieldDefs[key] = { type: spec, required: false };
      } else {
        fieldDefs[key] = {
          type: spec.type ?? 'any',
          required: spec.required ?? false,
          ...(spec.default !== undefined ? { default: spec.default } : {}),
        };
      }
    }

    class ConcreteError extends NamedError {
      constructor(data = {}) {
        // Build message from first string field or generic
        const msg = data.message || `${name}`;
        super(msg);
        this.name = name;

        // Validate and collect data
        const validated = {};
        for (const [key, def] of Object.entries(fieldDefs)) {
          const val = data[key] !== undefined ? data[key] : def.default;
          if (val === undefined) {
            if (def.required) {
              throw new TypeError(`NamedError "${name}": required field "${key}" is missing`);
            }
            continue;
          }
          const check = TYPE_VALIDATORS[def.type] || TYPE_VALIDATORS.any;
          if (!check(val)) {
            throw new TypeError(
              `NamedError "${name}": field "${key}" expected ${def.type}, got ${typeof val}`
            );
          }
          validated[key] = val;
        }
        this.data = validated;

        // Capture stack trace (V8)
        if (Error.captureStackTrace) {
          Error.captureStackTrace(this, ConcreteError);
        }
      }

      static tag = name;

      static isInstance(err) {
        return err instanceof ConcreteError;
      }

      toObject() {
        return { name: this.name, data: this.data, message: this.message };
      }
    }

    Object.defineProperty(ConcreteError, 'name', { value: name, configurable: true });
    return ConcreteError;
  }

  /**
   * Check if an unknown error has a matching .name property.
   * Safe to call on any value — returns false for non-errors.
   */
  static hasName(error, name) {
    return error instanceof Error && error.name === name;
  }

  /**
   * Check if an error is any NamedError (has a .data property from our factory).
   */
  static isNamedError(error) {
    return error instanceof NamedError && error.data !== undefined;
  }

  /**
   * Serialize a named error to a plain object.
   * Returns { name, data, message } for NamedErrors, or { name: 'UnknownError', message } for others.
   */
  static toObject(error) {
    if (error instanceof NamedError && error.data !== undefined) {
      return error.toObject();
    }
    return {
      name: error?.name || 'UnknownError',
      message: error?.message || String(error),
      data: {},
    };
  }
}

// ── Built-in named errors ────────────────────────────────────────────────────

export const UnknownError = NamedError.create('UnknownError', {
  message: { type: 'string', required: true },
  ref: 'string',
});

export const ToolExecutionError = NamedError.create('ToolExecutionError', {
  tool: { type: 'string', required: true },
  message: 'string',
});

export const ProviderError = NamedError.create('ProviderError', {
  provider: { type: 'string', required: true },
  status: 'number',
  message: 'string',
});

export const ConfigError = NamedError.create('ConfigError', {
  key: 'string',
  message: { type: 'string', required: true },
});

export const PermissionError = NamedError.create('PermissionError', {
  tool: 'string',
  action: 'string',
  message: { type: 'string', required: true },
});

export const ValidationError = NamedError.create('ValidationError', {
  field: 'string',
  message: { type: 'string', required: true },
});
