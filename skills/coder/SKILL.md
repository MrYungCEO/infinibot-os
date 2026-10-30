---
name: coder
description: "Expert software engineering skill for TypeScript, Python, Go development with git workflows, testing, and deployment."
metadata: {"infinibot":{"emoji":"💻","requires":{"anyBins":["node","npm","pnpm","python","go","git"]}}}
---

# 💻 CODER — Expert Software Engineering Skill

This skill defines professional software engineering practices, code architecture patterns, git workflows, testing requirements, and language-specific best practices.

---

## 🏗️ CODE ARCHITECTURE PATTERNS

### Project Structure Principles

```
project/
├── src/                    # Source code
│   ├── domain/             # Business logic, entities
│   ├── application/        # Use cases, services
│   ├── infrastructure/     # External integrations, DB
│   └── interfaces/         # API routes, controllers
├── tests/                  # Test files (mirror src structure)
├── scripts/                # Build/deploy scripts
├── docs/                   # Documentation
└── config/                 # Configuration files
```

### Architectural Patterns

#### 1. Clean Architecture (Layered)
```
┌─────────────────────────────────────────┐
│  Interfaces (Controllers, Routes)       │  ← HTTP/WebSocket handlers
├─────────────────────────────────────────┤
│  Application (Use Cases, Services)      │  ← Business orchestration
├─────────────────────────────────────────┤
│  Domain (Entities, Value Objects)       │  ← Pure business logic
├─────────────────────────────────────────┤
│  Infrastructure (DB, APIs, Queues)      │  ← External dependencies
└─────────────────────────────────────────┘
```

**Rules:**
- Dependencies point inward (outer depends on inner)
- Domain has ZERO external dependencies
- Infrastructure implements domain interfaces
- Use dependency injection for testability

#### 2. Module Pattern (TypeScript/Node)
```typescript
// src/modules/user/
├── user.entity.ts       // Domain entity
├── user.service.ts      // Business logic
├── user.repository.ts   // Data access
├── user.controller.ts   // HTTP handlers
├── user.dto.ts          // Request/response shapes
├── user.types.ts        // TypeScript interfaces
└── index.ts             // Public exports
```

#### 3. Feature Slices (Frontend)
```
src/features/
├── auth/
│   ├── components/      # Auth-specific components
│   ├── hooks/           # useAuth, useSession
│   ├── api/             # Auth API calls
│   ├── store/           # Auth state
│   └── index.ts         # Public API
├── dashboard/
│   ├── components/
│   ├── hooks/
│   └── index.ts
└── shared/              # Cross-cutting concerns
    ├── components/
    ├── hooks/
    └── utils/
```

### Design Principles

| Principle | Description | Example |
|-----------|-------------|---------|
| **SRP** | Single Responsibility | One class = one reason to change |
| **OCP** | Open/Closed | Extend via interfaces, not modification |
| **LSP** | Liskov Substitution | Subtypes must be substitutable |
| **ISP** | Interface Segregation | Many specific interfaces > one fat interface |
| **DIP** | Dependency Inversion | Depend on abstractions, not concretions |
| **KISS** | Keep It Simple | Simplest solution that works |
| **YAGNI** | You Aren't Gonna Need It | Don't build for hypotheticals |

---

## 🔀 GIT WORKFLOW

### Branch Naming Convention

```
main              # Production-ready code
├── develop       # Integration branch (optional)
├── feature/*     # New features
├── fix/*         # Bug fixes
├── hotfix/*      # Production emergency fixes
├── refactor/*    # Code refactoring
├── docs/*        # Documentation updates
├── test/*        # Test additions/fixes
└── chore/*       # Build, deps, tooling
```

**Examples:**
- `feature/user-authentication`
- `fix/login-validation-error`
- `hotfix/critical-security-patch`
- `refactor/extract-email-service`

### Commit Message Convention (Conventional Commits)

```
<type>(<scope>): <subject>

[optional body]

[optional footer(s)]
```

**Types:**
| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting, no code change |
| `refactor` | Code restructure, no behavior change |
| `perf` | Performance improvement |
| `test` | Adding/fixing tests |
| `chore` | Build, deps, tooling |
| `revert` | Revert previous commit |

**Examples:**
```bash
feat(auth): add JWT refresh token support

fix(api): handle null response from payment gateway

Closes #234

refactor(user)!: rename UserService to AccountService

BREAKING CHANGE: UserService no longer exists
```

### Git Commands Reference

```bash
# Create feature branch
git checkout -b feature/my-feature main

# Stage and commit with message
git add -A && git commit -m "feat(scope): description"

# Interactive rebase for clean history
git rebase -i HEAD~3

# Push with upstream tracking
git push -u origin feature/my-feature

# Squash merge to main
git checkout main && git merge --squash feature/my-feature

# Clean up merged branches
git branch -d feature/my-feature
git push origin --delete feature/my-feature
```

### Pull Request Checklist

- [ ] Branch is up-to-date with target branch
- [ ] Commits follow conventional format
- [ ] All tests pass
- [ ] Linting passes
- [ ] Documentation updated (if applicable)
- [ ] Breaking changes documented
- [ ] Screenshots for UI changes
- [ ] Linked to issue/ticket

---

## 🧪 TESTING REQUIREMENTS

### Test Pyramid

```
          ┌─────┐
          │ E2E │  ← Few (expensive, slow)
         ┌┴─────┴┐
         │ Integ │  ← Some (medium cost)
        ┌┴───────┴┐
        │  Unit   │  ← Many (cheap, fast)
        └─────────┘
```

### Test File Naming

```
src/user/user.service.ts
tests/user/user.service.test.ts       # Unit tests
tests/user/user.service.spec.ts       # Alternative
tests/user/user.integration.test.ts   # Integration
tests/e2e/user-flow.e2e.test.ts       # End-to-end
```

### Unit Test Structure (AAA Pattern)

```typescript
describe('UserService', () => {
  describe('createUser', () => {
    it('should create user with valid data', async () => {
      // Arrange
      const userData = { email: 'test@example.com', name: 'Test' };
      const mockRepo = { save: vi.fn().mockResolvedValue({ id: 1, ...userData }) };
      const service = new UserService(mockRepo);
      
      // Act
      const result = await service.createUser(userData);
      
      // Assert
      expect(result.id).toBe(1);
      expect(mockRepo.save).toHaveBeenCalledWith(userData);
    });

    it('should throw on duplicate email', async () => {
      // Arrange
      const userData = { email: 'exists@example.com' };
      const mockRepo = { save: vi.fn().mockRejectedValue(new DuplicateError()) };
      const service = new UserService(mockRepo);
      
      // Act & Assert
      await expect(service.createUser(userData)).rejects.toThrow(DuplicateError);
    });
  });
});
```

### Test Coverage Requirements

| Type | Minimum Coverage | Target |
|------|------------------|--------|
| Unit | 70% | 85%+ |
| Integration | 50% | 70%+ |
| E2E | Critical paths | Happy + key error paths |

### Testing Tools by Language

| Language | Unit | Integration | E2E | Mocking |
|----------|------|-------------|-----|---------|
| TypeScript | Vitest, Jest | Supertest | Playwright | vitest mock, jest.mock |
| Python | pytest | pytest | pytest + Selenium | unittest.mock, pytest-mock |
| Go | testing | testing | chromedp | gomock, testify/mock |

---

## ✅ CODE REVIEW CHECKLIST

### Functionality
- [ ] Code does what the PR description claims
- [ ] Edge cases handled
- [ ] No unintended side effects
- [ ] Error handling is appropriate

### Code Quality
- [ ] Follows existing project conventions
- [ ] No code duplication (DRY)
- [ ] Functions are focused (SRP)
- [ ] Names are clear and descriptive
- [ ] No commented-out code
- [ ] No console.log/print statements (unless logging)

### Architecture
- [ ] Changes are in the right layer
- [ ] Dependencies flow correctly
- [ ] No circular dependencies
- [ ] Appropriate abstraction level

### Performance
- [ ] No N+1 queries
- [ ] No unnecessary re-renders (React)
- [ ] Large data sets paginated
- [ ] Expensive operations cached/memoized

### Security
- [ ] Input validated
- [ ] Output encoded/escaped
- [ ] No secrets in code
- [ ] SQL injection prevented
- [ ] Auth/authz enforced

### Testing
- [ ] Tests added for new functionality
- [ ] Tests updated for changed behavior
- [ ] Test coverage maintained
- [ ] Tests are readable and maintainable

### Documentation
- [ ] Public APIs documented
- [ ] Complex logic has comments
- [ ] README updated if needed
- [ ] Breaking changes noted

---

## 📦 LANGUAGE-SPECIFIC BEST PRACTICES

### TypeScript/Node.js

```typescript
// ✅ Good: Strict types, no any
interface User {
  id: string;
  email: string;
  createdAt: Date;
}

async function getUser(id: string): Promise<User | null> {
  return userRepo.findById(id);
}

// ❌ Bad: any types, implicit returns
async function getUser(id): any {
  return userRepo.findById(id);
}
```

**Rules:**
- Enable `strict: true` in tsconfig
- Use `unknown` over `any`
- Prefer `interface` for object shapes
- Use `type` for unions, intersections, primitives
- Async/await over raw Promises
- Named exports over default exports
- Use `const` assertions for literals

**Project Config:**
```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true
  }
}
```

### Python

```python
# ✅ Good: Type hints, docstrings, error handling
from typing import Optional
from dataclasses import dataclass

@dataclass
class User:
    id: str
    email: str
    created_at: datetime

def get_user(user_id: str) -> Optional[User]:
    """
    Retrieve a user by ID.
    
    Args:
        user_id: The unique identifier of the user.
        
    Returns:
        The User object if found, None otherwise.
        
    Raises:
        DatabaseError: If the database connection fails.
    """
    try:
        return user_repo.find_by_id(user_id)
    except ConnectionError as e:
        raise DatabaseError(f"Failed to fetch user: {e}")
```

**Rules:**
- Type hints everywhere (PEP 484)
- Use dataclasses or Pydantic for data structures
- f-strings over .format()
- Context managers for resources (`with open()`)
- List/dict comprehensions over loops when readable
- Use `pathlib.Path` over `os.path`
- `logging` module over print()

**Project Config (pyproject.toml):**
```toml
[tool.ruff]
line-length = 100
select = ["E", "F", "W", "I", "UP", "B", "C4"]

[tool.mypy]
strict = true
python_version = "3.11"
```

### Go

```go
// ✅ Good: Error handling, interfaces, documentation
package user

import (
    "context"
    "errors"
    "fmt"
)

// ErrNotFound is returned when a user cannot be found.
var ErrNotFound = errors.New("user not found")

// User represents a system user.
type User struct {
    ID        string    `json:"id"`
    Email     string    `json:"email"`
    CreatedAt time.Time `json:"created_at"`
}

// Repository defines the user storage interface.
type Repository interface {
    FindByID(ctx context.Context, id string) (*User, error)
    Save(ctx context.Context, user *User) error
}

// Service handles user business logic.
type Service struct {
    repo Repository
}

// NewService creates a new user service.
func NewService(repo Repository) *Service {
    return &Service{repo: repo}
}

// GetUser retrieves a user by ID.
func (s *Service) GetUser(ctx context.Context, id string) (*User, error) {
    user, err := s.repo.FindByID(ctx, id)
    if err != nil {
        return nil, fmt.Errorf("get user %s: %w", id, err)
    }
    return user, nil
}
```

**Rules:**
- Accept interfaces, return structs
- Error wrapping with `fmt.Errorf("context: %w", err)`
- Context as first parameter
- Short variable names in limited scope
- Table-driven tests
- No global state
- Use `defer` for cleanup

**Linting:**
```bash
golangci-lint run --enable-all
```

---

## 🚀 BUILD & DEPLOY PROCEDURES

### Build Pipeline

```yaml
# CI Pipeline (GitHub Actions style)
build:
  - checkout code
  - install dependencies
  - lint & format check
  - type check
  - run unit tests
  - run integration tests
  - build artifacts
  - security scan
  - upload artifacts

deploy-staging:
  - download artifacts
  - run database migrations
  - deploy to staging
  - run smoke tests
  - notify team

deploy-production:
  - manual approval gate
  - download artifacts
  - create database backup
  - run migrations
  - blue-green deploy
  - run health checks
  - enable traffic
  - monitor for 15 min
  - rollback if errors
```

### Environment Management

```
.env.example      # Template (committed)
.env.local        # Local development (git ignored)
.env.staging      # Staging config
.env.production   # Production config (secrets via vault)
```

### Deployment Commands

```bash
# TypeScript/Node
pnpm build                    # Build for production
pnpm start                    # Start production server
pnpm db:migrate              # Run migrations
pnpm db:seed                 # Seed data

# Python
uv build                     # Build package
uv run python -m app         # Run application
alembic upgrade head         # Run migrations

# Go
go build -o bin/app ./cmd/app
./bin/app serve
go-migrate up
```

### Docker Best Practices

```dockerfile
# Multi-stage build for Node
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

### Health Checks

```typescript
// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: process.env.APP_VERSION,
    timestamp: new Date().toISOString()
  });
});

// Readiness check (with dependencies)
app.get('/ready', async (req, res) => {
  try {
    await db.ping();
    await redis.ping();
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});
```

---

## ⚠️ ERROR HANDLING PATTERNS

### TypeScript Error Handling

```typescript
// Custom error classes
class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public isOperational: boolean = true
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super(`${resource} with id ${id} not found`, 'NOT_FOUND', 404);
  }
}

class ValidationError extends AppError {
  constructor(message: string, public details?: Record<string, string>) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

// Error handling middleware
function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: (err as ValidationError).details
      }
    });
  }
  
  // Unexpected errors
  console.error('Unexpected error:', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred'
    }
  });
}
```

### Result Type Pattern

```typescript
type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };

async function createUser(data: CreateUserDTO): Promise<Result<User, AppError>> {
  const validation = validateUser(data);
  if (!validation.valid) {
    return { success: false, error: new ValidationError(validation.message) };
  }
  
  try {
    const user = await userRepo.create(data);
    return { success: true, data: user };
  } catch (err) {
    return { success: false, error: new AppError('Failed to create user', 'CREATE_FAILED') };
  }
}

// Usage
const result = await createUser(data);
if (result.success) {
  console.log('Created:', result.data.id);
} else {
  console.error('Failed:', result.error.message);
}
```

### Go Error Handling

```go
// Custom errors with context
type AppError struct {
    Code    string
    Message string
    Err     error
}

func (e *AppError) Error() string {
    if e.Err != nil {
        return fmt.Sprintf("%s: %v", e.Message, e.Err)
    }
    return e.Message
}

func (e *AppError) Unwrap() error {
    return e.Err
}

// Sentinel errors
var (
    ErrNotFound    = &AppError{Code: "NOT_FOUND", Message: "resource not found"}
    ErrValidation  = &AppError{Code: "VALIDATION", Message: "validation failed"}
)

// Error checking
if errors.Is(err, ErrNotFound) {
    return http.StatusNotFound
}
```

---

## ⚡ PERFORMANCE OPTIMIZATION

### Database Optimization

```typescript
// ❌ N+1 query problem
const users = await userRepo.findAll();
for (const user of users) {
  user.posts = await postRepo.findByUserId(user.id); // N queries!
}

// ✅ Eager loading / JOIN
const users = await userRepo.findAllWithPosts(); // 1 query

// ✅ Batch loading
const userIds = users.map(u => u.id);
const posts = await postRepo.findByUserIds(userIds); // 1 query
const postsByUser = groupBy(posts, 'userId');
users.forEach(u => u.posts = postsByUser[u.id] || []);
```

### Caching Strategy

```typescript
// Cache-aside pattern
async function getUser(id: string): Promise<User> {
  const cacheKey = `user:${id}`;
  
  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  
  // Miss: fetch from DB
  const user = await db.user.findById(id);
  if (!user) throw new NotFoundError('User', id);
  
  // Populate cache (5 min TTL)
  await redis.setex(cacheKey, 300, JSON.stringify(user));
  
  return user;
}

// Invalidation on update
async function updateUser(id: string, data: UpdateUserDTO): Promise<User> {
  const user = await db.user.update(id, data);
  await redis.del(`user:${id}`);
  return user;
}
```

### React Performance

```tsx
// ✅ Memoization
const ExpensiveComponent = React.memo(({ data }) => {
  return <div>{/* expensive render */}</div>;
});

// ✅ useMemo for expensive computations
const sortedData = useMemo(() => {
  return data.slice().sort((a, b) => a.name.localeCompare(b.name));
}, [data]);

// ✅ useCallback for stable references
const handleClick = useCallback((id: string) => {
  dispatch(selectItem(id));
}, [dispatch]);

// ✅ Virtual list for large datasets
import { useVirtualizer } from '@tanstack/react-virtual';

function VirtualList({ items }) {
  const parentRef = useRef(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 50,
  });
  // ...render virtual items
}
```

### Query Optimization

```sql
-- Add indexes for common queries
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_posts_user_created ON posts(user_id, created_at DESC);

-- Use EXPLAIN to analyze
EXPLAIN ANALYZE SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10;

-- Pagination with cursors (not OFFSET)
SELECT * FROM posts 
WHERE user_id = $1 AND created_at < $cursor
ORDER BY created_at DESC
LIMIT 10;
```

---

## 🔧 DEVELOPMENT COMMANDS

### Quick Reference

```bash
# TypeScript/Node (pnpm)
pnpm dev              # Start dev server
pnpm build            # Build for production
pnpm test             # Run tests
pnpm test:watch       # Watch mode
pnpm test:coverage    # With coverage
pnpm lint             # Lint code
pnpm lint:fix         # Auto-fix
pnpm format           # Format with Prettier
pnpm typecheck        # TypeScript check

# Python (uv)
uv run pytest         # Run tests
uv run pytest --cov   # With coverage
uv run ruff check .   # Lint
uv run ruff format .  # Format
uv run mypy .         # Type check

# Go
go run ./cmd/app      # Run application
go test ./...         # Run all tests
go test -cover ./...  # With coverage
golangci-lint run     # Lint
go mod tidy           # Clean dependencies

# Git
git status            # Check status
git diff              # View changes
git log --oneline -10 # Recent commits
```

---

## 📋 TEMPLATES

### New API Endpoint Checklist

- [ ] Define route and HTTP method
- [ ] Create/update DTOs for request/response
- [ ] Implement controller handler
- [ ] Add validation middleware
- [ ] Implement service logic
- [ ] Add database operations
- [ ] Write unit tests for service
- [ ] Write integration tests for endpoint
- [ ] Add OpenAPI documentation
- [ ] Handle error cases

### Bug Fix Checklist

- [ ] Reproduce the bug
- [ ] Write a failing test
- [ ] Identify root cause
- [ ] Implement fix
- [ ] Verify test passes
- [ ] Check for related issues
- [ ] Update documentation if needed
- [ ] Add regression test

---

## 💡 TIPS & HEURISTICS

1. **Start with the interface** — Define the API/contract before implementation
2. **Write tests first** — TDD forces better design
3. **Commit early, commit often** — Small, focused commits
4. **Refactor in separate commits** — Don't mix refactoring with features
5. **Code for readability** — You write once, read many times
6. **Delete dead code** — Git remembers, your codebase shouldn't
7. **Log appropriately** — Error details for errors, info for flow
8. **Document the why** — Code shows what, comments explain why
9. **Review your own PR first** — Catch obvious issues before review
10. **Keep functions small** — If it doesn't fit on a screen, split it
