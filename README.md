# Flash Sale Order Processing System (AWS + Node.js)

A practical implementation of a **Flash Sale Order Processing System** built using AWS services like **SQS**, **Lambda**, **DynamoDB**, and **EventBridge**, along with a **Node.js backend**.  
This project demonstrates how to handle high-traffic flash-sale scenarios by capturing orders quickly and processing them asynchronously at scale.

---

## 🏷️ Tech Stack
- **Node.js** (Backend API)
- **Amazon SQS** (Queueing)
- **AWS Lambda** (Async processing + cleanup)
- **DynamoDB** (Inventory & orders)
- **EventBridge Scheduler** (Timeout monitoring)
- **Artillery** (Load testing)

---

## 📊 Architecture Overview
> A detailed diagram is available in the Medium article.  
> (You can add your architecture PNG here once uploaded.)

---

## 🚀 Features
- Realistic flash-sale order workflow  
- Atomic inventory reservation (prevents overselling)  
- Asynchronous processing using SQS  
- Payment simulation + webhook handler  
- Scheduled cleanup for stale pending orders  
- Load testing with 500+ requests/sec  

---

## 🛠 Installation

### 1. Install project dependencies
```bash
npm install
```

### 2. Install AWS CLI
- AWS services require authentication before your local machine can access them, you will find the instructions here - https://aws.amazon.com/cli/
- After installing aws-cli, configure it:
```bash
aws configure
```

Enter:
- AWS Access Key ID
- AWS Secret Access Key
- Default region (example: ap-south-1)
- Output format → json

This stores credentials in ~/.aws/credentials.

### 3. Environment Variables
Create a .env file in the root directory:
```
QUEUE_URL=
AWS_REGION=
```

### 4. Running the application

Start the backend server
```
node app
```
Your server is ready to accept requests

---

## 🧪 Load Testing
### 1. Install Artillery
```
npm install -g artillery
```

### 2. Run the load test
```
artillery run load-test.yml
```

Artillery will automatically read:

```load-test.yml``` 
→ traffic configuration

```test.sv```
 → sample payloads

## 📚 Medium Article
Full explanation, diagrams, and load-test analysis:


## 🤝 Contributing
PRs and issues are welcome — this project is evolving as I continue learning and experimenting.
## ⭐ Support the Project
If this project helped you, consider starring ⭐ the repository!
