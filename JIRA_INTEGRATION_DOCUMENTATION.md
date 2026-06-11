# Jira Portal Integration API Documentation

## Overview
This documentation provides comprehensive details about the Jira integration implementation in the MM Portal Integration API. The integration allows seamless synchronization between Jira and MeraMonitor systems.

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [Authentication](#authentication)
3. [API Endpoints](#api-endpoints)
4. [Service Implementations](#service-implementations)
5. [Data Models](#data-models)
6. [Configuration](#configuration)
7. [Usage Examples](#usage-examples)
8. [Error Handling](#error-handling)
9. [Best Practices](#best-practices)

---

## Architecture Overview

The Jira integration follows a layered architecture pattern consistent with other portal integrations:

### Components
```
???????????????????????????????????????????????????????????
?                   Controller Layer                       ?
?            (PortalIntegrationController)                 ?
???????????????????????????????????????????????????????????
                        ?
???????????????????????????????????????????????????????????
?              Service Factory Layer                       ?
?        (PortalIntegrationServiceFactory)                 ?
???????????????????????????????????????????????????????????
                        ?
???????????????????????????????????????????????????????????
?           Integration Service Layer                      ?
?            (JiraIntegrationService)                      ?
?  - User Management                                       ?
?  - Task/Issue Management                                 ?
?  - Worklog/Time Entry Management                         ?
?  - OAuth Authentication                                  ?
???????????????????????????????????????????????????????????
                        ?
???????????????????????????????????????????????????????????
?              API Client Layer                            ?
?            (JiraApiClientService)                        ?
?  - REST API Communication                                ?
?  - Request/Response Handling                             ?
?  - Pagination Management                                 ?
???????????????????????????????????????????????????????????
```

### Key Files Created

1. **Models/DTOs:**
   - `MMPortalIntegrationApi.Dtos\Responses\JiraResponse.cs`

2. **Service Interfaces:**
   - `MMPortalIntegrationApi.Services\Interfaces\IJiraApiClientService.cs`

3. **Service Implementations:**
   - `MMPortalIntegrationApi.Services\Services\ClientService\JiraApiClientService.cs`
   - `MMPortalIntegrationApi.Services\Services\JiraIntegrationService.cs`

4. **Configuration Updates:**
   - `MMPortalIntegrationApi.Services\Services\PortalIntegrationServiceFactory.cs`
   - `MMPortalIntegrationApi\Program.cs`

---

## Authentication

Jira uses OAuth 2.0 authentication flow. This implementation supports the Authorization Code Grant flow.

### OAuth 2.0 Flow

```
????????????                                           ????????????
?          ???(1) Authorization Request????????????????          ?
?          ?                                           ?          ?
?  Client  ?                                           ?   Jira   ?
?          ???(2) Authorization Code???????????????????  OAuth   ?
?          ?                                           ?  Server  ?
????????????                                           ????????????
      ?                                                     ?
      ?                                                     ?
      ?                                                     ?
      ???(3) Exchange Code for Token????????????????????????
         (4) Access Token ??????????????????????????????????
```

### Authentication Configuration

Required configuration parameters:
```json
{
  "ClientID": "your-jira-oauth-client-id",
  "ClientSecret": "your-jira-oauth-client-secret",
  "RedirectUri": "https://your-app.com/oauth/callback",
  "AuthURL": "https://auth.atlassian.com/authorize",
  "AccessTokenURL": "https://auth.atlassian.com/oauth/token"
}
```

### OAuth Scopes Required
- `read:jira-work` - Read issues, projects, and worklogs
- `read:jira-user` - Read user information
- `write:jira-work` - Create and update worklogs
- `offline_access` - Get refresh token for long-term access

---

## API Endpoints

### Base URL
```
{BaseUrl}/api/PortalIntegration
```

### Common Headers
```
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json
```

### 1. Generate OAuth Authorization URL

**Endpoint:** `POST /oauth/generate-auth-url`

**Purpose:** Generate the Jira OAuth authorization URL to initiate the OAuth flow.

**Request Body:**
```json
{
  "portalName": "Jira",
  "clientID": "your-client-id",
  "redirectUri": "https://your-app.com/oauth/callback"
}
```

**Response:**
```json
{
  "success": true,
  "authUrl": "https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=...",
  "state": "unique-state-value"
}
```

**Usage:**
1. Call this endpoint to get the authorization URL
2. Redirect the user to the `authUrl`
3. User authorizes the application
4. Jira redirects back to your `redirectUri` with an authorization code

---

### 2. Exchange Authorization Code for Token

**Endpoint:** `POST /oauth/generate-token`

**Purpose:** Exchange the authorization code for an access token and refresh token.

**Request Body:**
```json
{
  "portalName": "Jira",
  "clientID": "your-client-id",
  "clientSecret": "your-client-secret",
  "redirectUri": "https://your-app.com/oauth/callback",
  "authCode": "authorization-code-from-callback"
}
```

**Response:**
```json
{
  "success": true,
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "refresh-token-value",
  "expiresIn": 3600
}
```

---

### 3. Get Users

**Endpoint:** `POST /users`

**Purpose:** Retrieve users from Jira.

**Request Body:**
```json
{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "your-access-token"
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "557058:f1c1a5b8-...",
      "fullName": "John Doe",
      "firstName": "John",
      "lastName": "Doe",
      "mail": "john.doe@example.com",
      "login": "john.doe@example.com",
      "admin": false,
      "createdOn": "2024-01-01T00:00:00Z",
      "updatedOn": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

### 4. Get User by Property

**Endpoint:** `POST /users/by-property`

**Purpose:** Search for specific users by email or other properties.

**Request Body:**
```json
{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "your-access-token",
  "adminEmail": "john.doe@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "557058:f1c1a5b8-...",
      "fullName": "John Doe",
      "mail": "john.doe@example.com"
    }
  ]
}
```

---

### 5. Get Tasks/Issues

**Endpoint:** `POST /tasks`

**Purpose:** Retrieve tasks/issues assigned to a specific user.

**Request Body:**
```json
{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "your-access-token",
  "id": "557058:f1c1a5b8-..."
}
```

**JQL Query Used:**
```
assignee = '{userId}' AND statusCategory != Done
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "10001",
      "subject": "Implement Jira integration",
      "description": "Create full Jira integration with OAuth support",
      "project": {
        "id": "10000",
        "name": "MM Portal Integration"
      },
      "status": {
        "id": "3",
        "name": "In Progress",
        "isClosed": false
      },
      "assignedTo": {
        "id": "557058:f1c1a5b8-...",
        "name": "John Doe"
      },
      "startDate": "2024-01-01T00:00:00Z",
      "dueDate": "2024-01-31T00:00:00Z",
      "estimatedHours": 40.0,
      "spentHours": 15.5,
      "createdOn": "2024-01-01T00:00:00Z",
      "updatedOn": "2024-01-15T10:30:00Z"
    }
  ]
}
```

---

### 6. Update Task/Issue

**Endpoint:** `PUT /tasks/{issueKey}`

**Purpose:** Update an existing Jira issue.

**Request Body:**
```json
{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "your-access-token",
  "id": "PROJ-123",
  "body": {
    "fields": {
      "summary": "Updated issue summary",
      "description": "Updated description",
      "duedate": "2024-02-28"
    }
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Issue updated successfully"
}
```

---

### 7. Save Time Entry (Worklog)

**Endpoint:** `POST /time-entries`

**Purpose:** Create a new worklog entry for an issue.

**Request Body:**
```json
{
  "portalName": "Jira",
  "baseUrl": "https://your-domain.atlassian.net",
  "authToken": "your-access-token",
  "id": "PROJ-123",
  "body": {
    "comment": "Working on integration",
    "started": "2024-01-15T09:00:00.000+0000",
    "timeSpentSeconds": 14400
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "10050",
    "issueId": "10001",
    "hours": 4.0,
    "comments": "Working on integration",
    "spentOn": "2024-01-15",
    "createdOn": "2024-01-15T09:00:00Z"
  }
}
```

---

## Service Implementations

### JiraApiClientService

**Location:** `MMPortalIntegrationApi.Services\Services\ClientService\JiraApiClientService.cs`

**Purpose:** Handles all direct communication with Jira REST API v3.

**Key Methods:**

#### GetAllUsers
```csharp
Task<List<JiraUser>> GetAllUsers(
    string baseUrl, 
    string authToken, 
    int startAt, 
    int maxResults, 
    string query
);
```
- Retrieves all users from Jira
- Supports pagination
- Returns list of JiraUser objects

#### GetIssuesByProperty
```csharp
Task<List<JiraIssue>> GetIssuesByProperty(
    string baseUrl, 
    string authToken, 
    int startAt, 
    int maxResults, 
    string jql
);
```
- Searches issues using JQL (Jira Query Language)
- Supports complex filtering
- Includes all fields

#### SaveWorklog
```csharp
Task<JiraWorklogResponse> SaveWorklog(
    string baseUrl, 
    string authToken, 
    string issueKey, 
    object body
);
```
- Creates new worklog entries
- Time is in seconds
- Supports comments and timestamps

#### OAuth Methods
```csharp
Task<string> GenerateAuthUrl(
    string clientId, 
    string redirectUri, 
    string scope, 
    string state
);

Task<JiraAuthResponse> GetAccessToken(
    string tokenUrl, 
    string clientId, 
    string clientSecret, 
    string code, 
    string redirectUri
);
```
- Handles OAuth 2.0 flow
- Generates authorization URLs
- Exchanges codes for tokens

---

### JiraIntegrationService

**Location:** `MMPortalIntegrationApi.Services\Services\JiraIntegrationService.cs`

**Purpose:** Implements the IPortalIntegrationService interface for Jira, providing standardized integration methods.

**Key Features:**
- Maps Jira data to portal integration models
- Implements task comparison logic
- Handles OAuth authentication flow
- Converts time between seconds and hours

**Important Methods:**

#### GetTaskByProperty
```csharp
public async Task<List<PortalIntegrationTask>> GetTaskByProperty(
    PortalIntegrationApiParameter apiParameter
)
```
- Gets tasks assigned to a specific user
- Excludes completed tasks
- Uses JQL: `assignee = '{userId}' AND statusCategory != Done`

#### GetMMUserTasksWithDifferences
```csharp
public async Task<List<ExternalTaskAllocationResponse>> GetMMUserTasksWithDifferences(
    List<PortalIntegrationTask> portalUserProjectTasks, 
    List<ExternalTaskAllocationResponse> mmUserTasks
)
```
- Compares MeraMonitor tasks with Jira issues
- Identifies tasks with differences
- Returns tasks that need to be updated

#### MapJiraIssueToPortalTask
```csharp
private PortalIntegrationTask MapJiraIssueToPortalTask(JiraIssue item)
```
- Converts Jira issue to standard portal task format
- Handles time conversions (seconds to hours)
- Maps status to closed/open state

---

## Data Models

### JiraUser
```csharp
public class JiraUser
{
    public string AccountId { get; set; }
    public string DisplayName { get; set; }
    public string EmailAddress { get; set; }
    public bool Active { get; set; }
    public string AccountType { get; set; }
}
```

### JiraIssue
```csharp
public class JiraIssue
{
    public string Id { get; set; }
    public string Key { get; set; }
    public JiraIssueFields Fields { get; set; }
}

public class JiraIssueFields
{
    public string Summary { get; set; }
    public string Description { get; set; }
    public JiraStatus Status { get; set; }
    public JiraUser Assignee { get; set; }
    public JiraProject Project { get; set; }
    public DateTime Created { get; set; }
    public DateTime Updated { get; set; }
    public DateTime? DueDate { get; set; }
    public int? TimeEstimate { get; set; }      // in seconds
    public int? TimeSpent { get; set; }         // in seconds
}
```

### JiraWorklog
```csharp
public class JiraWorklog
{
    public string Id { get; set; }
    public string IssueId { get; set; }
    public JiraUser Author { get; set; }
    public string Comment { get; set; }
    public DateTime Started { get; set; }
    public string TimeSpent { get; set; }       // e.g., "4h 30m"
    public int TimeSpentSeconds { get; set; }   // in seconds
    public DateTime Created { get; set; }
    public DateTime Updated { get; set; }
}
```

### JiraStatus Enumeration
```csharp
public enum JiraIssueStatus
{
    ToDo = 1,
    InProgress = 2,
    Done = 3,
    InReview = 4,
    Backlog = 5,
    Selected = 6,
    Closed = 7,
    Resolved = 8,
    Reopened = 9,
    OnHold = 10
}
```

---

## Configuration

### Database Configuration

Add Jira portal configuration to the `PortalConfiguration` collection in MongoDB:

```json
{
  "portalName": "Jira",
  "portalURL": "https://your-domain.atlassian.net",
  "contactEmail": "admin@example.com",
  "contactNumber": "+1234567890",
  "mmApiKey": "your-mm-api-key",
  "mmPortalId": "portal-id-from-mm",
  "mmPortalName": "Jira Integration",
  "isActive": true,
  "createdDate": "2024-01-01T00:00:00Z",
  "modifiedDate": "2024-01-01T00:00:00Z"
}
```

### OAuth Configuration

Add OAuth configuration to the `PortalOrgApiConfig` collection:

```json
{
  "portalConfigurationId": "portal-config-id",
  "organizationId": "org-id",
  "apiKey": "",
  "accessToken": "oauth-access-token",
  "refreshToken": "oauth-refresh-token",
  "tokenExpiry": "2024-01-01T01:00:00Z",
  "clientId": "your-oauth-client-id",
  "clientSecret": "your-oauth-client-secret",
  "authUrl": "https://auth.atlassian.com/authorize",
  "tokenUrl": "https://auth.atlassian.com/oauth/token",
  "redirectUri": "https://your-app.com/oauth/callback",
  "scope": "read:jira-work read:jira-user write:jira-work offline_access",
  "isActive": true,
  "createdDate": "2024-01-01T00:00:00Z",
  "modifiedDate": "2024-01-01T00:00:00Z"
}
```

### Application Settings (appsettings.json)

```json
{
  "JiraIntegration": {
    "ApiVersion": "3",
    "MaxResults": 50,
    "RequestTimeoutSeconds": 30,
    "RetryAttempts": 3
  }
}
```

---

## Usage Examples

### Example 1: Complete OAuth Flow

```csharp
// Step 1: Generate authorization URL
var authUrlRequest = new PortalIntegrationApiParameter
{
    PortalName = "Jira",
    ClientID = "your-client-id",
    RedirectUri = "https://your-app.com/oauth/callback"
};

var authResponse = await jiraIntegrationService.GenerateFormAuthUrl(authUrlRequest);
// Redirect user to: authResponse.AuthUrl

// Step 2: After user authorizes, receive callback with code
// GET https://your-app.com/oauth/callback?code=AUTH_CODE&state=STATE

// Step 3: Exchange code for token
var tokenRequest = new PortalIntegrationApiParameter
{
    PortalName = "Jira",
    ClientID = "your-client-id",
    ClientSecret = "your-client-secret",
    RedirectUri = "https://your-app.com/oauth/callback"
};

var tokenResponse = await jiraIntegrationService.GenerateToken(
    tokenRequest, 
    "AUTH_CODE", 
    null
);

// Store tokenResponse.AccessToken and tokenResponse.RefreshToken
```

### Example 2: Sync User Tasks

```csharp
// Get user from Jira
var userRequest = new PortalIntegrationApiParameter
{
    PortalName = "Jira",
    BaseUrl = "https://your-domain.atlassian.net",
    AuthToken = "access-token",
    AdminEmail = "user@example.com"
};

var jiraUsers = await jiraIntegrationService.GetUserByProperty(userRequest);
var jiraUser = jiraUsers.FirstOrDefault();

// Get user's tasks
var taskRequest = new PortalIntegrationApiParameter
{
    PortalName = "Jira",
    BaseUrl = "https://your-domain.atlassian.net",
    AuthToken = "access-token",
    Id = jiraUser.Id
};

var jiraTasks = await jiraIntegrationService.GetTaskByProperty(taskRequest);

// Compare with MM tasks
var mmTasks = await GetMMUserTasks(jiraUser.Id);
var tasksWithDifferences = await jiraIntegrationService.GetMMUserTasksWithDifferences(
    jiraTasks, 
    mmTasks
);

// Update MM with differences
foreach (var task in tasksWithDifferences)
{
    await UpdateMMTask(task);
}
```

### Example 3: Log Time to Jira

```csharp
// Create worklog request
var worklogRequest = new PortalIntegrationApiParameter
{
    PortalName = "Jira",
    BaseUrl = "https://your-domain.atlassian.net",
    AuthToken = "access-token",
    Id = "PROJ-123", // Issue key
    Body = new JiraWorklogCreateRequest
    {
        Comment = "Completed feature development",
        Started = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff+0000"),
        TimeSpentSeconds = 14400 // 4 hours
    }
};

var worklogResponse = await jiraIntegrationService.SaveTimeEntry(worklogRequest);
```

### Example 4: Update Issue

```csharp
// Update issue request
var updateRequest = new PortalIntegrationApiParameter
{
    PortalName = "Jira",
    BaseUrl = "https://your-domain.atlassian.net",
    AuthToken = "access-token",
    Id = "PROJ-123",
    Body = new JiraIssueUpdateRequest
    {
        Fields = new Dictionary<string, object>
        {
            { "summary", "Updated issue title" },
            { "description", "Updated description" },
            { "duedate", "2024-12-31" }
        }
    }
};

var updateResponse = await jiraIntegrationService.UpdateTask(updateRequest);
```

---

## Error Handling

### Common Errors and Solutions

#### 1. Authentication Errors

**Error:** `401 Unauthorized`
```json
{
  "success": false,
  "message": "Unauthorized access",
  "statusCode": 401
}
```

**Solutions:**
- Verify access token is valid and not expired
- Check if token has required scopes
- Refresh the access token using refresh token

#### 2. Invalid JQL Query

**Error:** `400 Bad Request - Invalid JQL`
```json
{
  "success": false,
  "message": "Invalid JQL query",
  "errors": ["Field 'assignee' does not exist"]
}
```

**Solutions:**
- Validate JQL syntax
- Ensure field names are correct
- Use Jira's JQL validator

#### 3. Rate Limiting

**Error:** `429 Too Many Requests`
```json
{
  "success": false,
  "message": "Rate limit exceeded",
  "statusCode": 429
}
```

**Solutions:**
- Implement exponential backoff
- Cache frequently accessed data
- Reduce request frequency

#### 4. Issue Not Found

**Error:** `404 Not Found`
```json
{
  "success": false,
  "message": "Issue does not exist or you do not have permission",
  "statusCode": 404
}
```

**Solutions:**
- Verify issue key is correct
- Check user has permission to access the issue
- Ensure issue hasn't been deleted

### Logging

The implementation includes comprehensive logging:

```csharp
_logger.LogInformation("Getting all Jira users");
_logger.LogError($"Error updating Jira issue {issueKey}: {ex.Message}");
```

Monitor logs in:
- Console output
- MongoDB `Logs` collection
- Application Insights (if configured)

---

## Best Practices

### 1. Token Management

**Refresh Tokens:**
```csharp
// Check if token is expiring soon (within 5 minutes)
if (tokenExpiry - DateTime.UtcNow < TimeSpan.FromMinutes(5))
{
    // Refresh the token
    var newToken = await RefreshAccessToken(refreshToken);
    // Update stored tokens
    await UpdateStoredTokens(newToken);
}
```

### 2. Pagination

Always use pagination for large datasets:
```csharp
int maxResults = 50; // Jira's default
int startAt = 0;

// The service handles pagination automatically
var allIssues = await GetAllIssues(baseUrl, token, startAt, maxResults, jql);
```

### 3. JQL Optimization

**Good:**
```
assignee = currentUser() AND statusCategory != Done AND updated >= -7d
```

**Bad:**
```
assignee = currentUser() // Returns all issues ever
```

Tips:
- Use date filters to limit results
- Filter by project when possible
- Use status categories instead of specific statuses

### 4. Time Conversion

Jira uses seconds for time tracking:
```csharp
// Convert hours to seconds
int timeSpentSeconds = (int)(hours * 3600);

// Convert seconds to hours
double hours = timeSpentSeconds / 3600.0;
```

### 5. Error Handling Pattern

```csharp
try
{
    var result = await jiraApiClientService.GetIssues(...);

    if (result == null || result.Count == 0)
    {
        _logger.LogWarning("No issues found");
        return new List<PortalIntegrationTask>();
    }

    return MapToPortalTasks(result);
}
catch (HttpRequestException ex)
{
    _logger.LogError($"HTTP error: {ex.Message}");
    throw new IntegrationException("Failed to communicate with Jira", ex);
}
catch (Exception ex)
{
    _logger.LogError($"Unexpected error: {ex.Message}");
    throw;
}
```

### 6. Caching Strategy

Implement caching for:
- User information (cache for 1 hour)
- Project lists (cache for 1 day)
- Status lists (cache for 1 day)

Don't cache:
- Issue details
- Worklog entries
- Real-time data

### 7. Batch Operations

When syncing multiple items:
```csharp
var tasks = new List<Task>();
const int batchSize = 10;

for (int i = 0; i < items.Count; i += batchSize)
{
    var batch = items.Skip(i).Take(batchSize);
    foreach (var item in batch)
    {
        tasks.Add(ProcessItem(item));
    }

    await Task.WhenAll(tasks);
    tasks.Clear();

    // Small delay to avoid rate limiting
    await Task.Delay(100);
}
```

---

## Testing

### Unit Testing Example

```csharp
[Fact]
public async Task GetTaskByProperty_ShouldReturnUserTasks()
{
    // Arrange
    var mockJiraClient = new Mock<IJiraApiClientService>();
    var mockLogger = new Mock<ILogger<JiraIntegrationService>>();

    var jiraIssues = new List<JiraIssue>
    {
        new JiraIssue
        {
            Id = "10001",
            Key = "PROJ-1",
            Fields = new JiraIssueFields
            {
                Summary = "Test Issue",
                Status = new JiraStatus { Name = "In Progress" }
            }
        }
    };

    mockJiraClient
        .Setup(x => x.GetIssuesByProperty(
            It.IsAny<string>(), 
            It.IsAny<string>(), 
            It.IsAny<int>(), 
            It.IsAny<int>(), 
            It.IsAny<string>()))
        .ReturnsAsync(jiraIssues);

    var service = new JiraIntegrationService(mockLogger.Object, mockJiraClient.Object);

    var apiParameter = new PortalIntegrationApiParameter
    {
        BaseUrl = "https://test.atlassian.net",
        AuthToken = "test-token",
        Id = "user-123"
    };

    // Act
    var result = await service.GetTaskByProperty(apiParameter);

    // Assert
    Assert.NotNull(result);
    Assert.Single(result);
    Assert.Equal("10001", result[0].Id);
    Assert.Equal("Test Issue", result[0].Subject);
}
```

### Integration Testing

Test with a Jira sandbox environment:
1. Create a test Jira instance
2. Set up test users and projects
3. Run integration tests
4. Clean up test data

---

## Troubleshooting

### Issue: OAuth callback not working

**Check:**
1. Redirect URI matches exactly in OAuth app settings
2. State parameter is validated
3. Authorization code hasn't expired (valid for 60 seconds)

### Issue: Issues not syncing

**Check:**
1. User has permission to view issues
2. JQL query is valid
3. Token has `read:jira-work` scope
4. Network connectivity to Jira

### Issue: Time entries not creating

**Check:**
1. Token has `write:jira-work` scope
2. Issue exists and is not closed
3. Time format is correct (seconds)
4. User has permission to log work

---

## API Rate Limits

Jira Cloud rate limits (as of 2024):
- **REST API:** 10 requests per second per user
- **OAuth:** 600 requests per minute per IP

**Best practices:**
- Implement exponential backoff
- Use bulk APIs when available
- Cache frequently accessed data
- Monitor rate limit headers

---

## Security Considerations

1. **Token Storage:**
   - Encrypt tokens at rest
   - Use secure key management
   - Rotate tokens regularly

2. **API Communication:**
   - Always use HTTPS
   - Validate SSL certificates
   - Implement request signing

3. **Data Privacy:**
   - Log only necessary information
   - Mask sensitive data in logs
   - Comply with GDPR/data regulations

4. **Access Control:**
   - Implement least privilege
   - Validate user permissions
   - Audit access logs

---

## Support and Resources

### Official Jira API Documentation
- [Jira REST API v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
- [Jira OAuth 2.0](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)
- [JQL Reference](https://support.atlassian.com/jira-software-cloud/docs/what-is-advanced-searching-in-jira-cloud/)

### Code Repository
- Branch: `PerfectoHRIntegration` (includes Jira implementation)
- Base Path: `MMPortalIntegrationApi.Services`

### Contact
For issues or questions, contact the development team.

---

## Changelog

### Version 1.0.0 (2024-01-15)
- Initial Jira integration implementation
- OAuth 2.0 authentication support
- User, issue, and worklog management
- Full API documentation

---

**Document Version:** 1.0.0  
**Last Updated:** 2024-01-15  
**Author:** Development Team
