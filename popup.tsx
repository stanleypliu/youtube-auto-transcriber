import { useState, useEffect } from "react"
import { useStorage } from "@plasmohq/storage/hook"

function IndexPopup() {
  const [apiKey, setApiKey] = useStorage("google_api_key", "")
  const [status, setStatus] = useState("Ready")
  const [isRecording, setIsRecording] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [chunksProcessed, setChunksProcessed] = useState(0)
  const [lastActivity, setLastActivity] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [recordingMessage, setRecordingMessage] = useState("")

  const saveApiKey = () => {
    if (apiKey.trim()) {
      setStatus("Google Cloud API key saved!")
      setTimeout(() => setStatus("Ready"), 2000)
    } else {
      setStatus("Please enter a valid API key")
      setTimeout(() => setStatus("Ready"), 2000)
    }
  }

  const testApiKey = async () => {
    if (!apiKey.trim()) {
      setStatus("No API key to test")
      return
    }

    setStatus("Testing API key...")
    
    try {
      // Test API key format and basic validation
      if (apiKey.length < 20) {
        setStatus("❌ API key too short")
        return
      }
      
      // Test with a simple API call that's less likely to be restricted
      const response = await fetch(`https://www.googleapis.com/discovery/v1/apis/speech/v1/rest?key=${apiKey}`)
      
      if (response.ok) {
        setStatus("✅ API key is valid!")
      } else if (response.status === 403) {
        setStatus("❌ API key restricted - check Google Cloud settings")
      } else {
        setStatus("❌ API key is invalid")
      }
    } catch (error) {
      console.error('API key test error:', error)
      setStatus("❌ Failed to test API key")
    }
    
    setTimeout(() => setStatus("Ready"), 3000)
  }

  // Listen for messages from background script
  useEffect(() => {
    const handleMessage = (message: any) => {
      console.log('Popup received message:', message)
      
      if (message.type === 'recordingState') {
        console.log('Setting recording state to:', message.isRecording)
        setIsRecording(message.isRecording)
        if (!message.isRecording) {
          setRecordingDuration(0)
          setChunksProcessed(0)
          setLastActivity("Recording stopped")
          setRecordingMessage("")
        }
      } else if (message.type === 'chunkProcessed') {
        setChunksProcessed(prev => prev + 1)
        setLastActivity(`Processed chunk ${message.chunkNumber} (${message.language})`)
      } else if (message.type === 'fileSaved') {
        setLastActivity(`File saved: ${message.filename}`)
      } else if (message.type === 'recordingError') {
        setLastActivity(`Error: ${message.error}`)
        setIsRecording(false)
        setRecordingMessage("")
      }
    }

    // Listen for messages from background script
    chrome.runtime.onMessage.addListener(handleMessage)
    
    // Get current recording state
    checkRecordingState()

    return () => {
      chrome.runtime.onMessage.removeListener(handleMessage)
    }
  }, [])

  // Update recording duration timer
  useEffect(() => {
    let interval: NodeJS.Timeout
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingDuration(prev => prev + 1)
      }, 1000)
    }
    return () => {
      if (interval) clearInterval(interval)
    }
  }, [isRecording])

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const toggleRecording = async () => {
    setIsLoading(true)
    console.log('Toggle recording clicked, current state:', isRecording)
    
    if (isRecording) {
      console.log('Sending stopRecording message')
      chrome.runtime.sendMessage({ type: 'stopRecording' })
    } else {
      console.log('Sending startRecording message')
      try {
        const response = await chrome.runtime.sendMessage({ type: 'startRecording' })
        if (response.success && response.message) {
          setRecordingMessage(response.message)
        }
      } catch (error) {
        console.error('Failed to start recording:', error)
        setRecordingMessage('Failed to start recording')
      }
    }
    
    // Reset loading state after a short delay
    setTimeout(() => {
      setIsLoading(false)
    }, 1000)
  }

  const checkRecordingState = async () => {
    try {
      console.log('Checking recording state...')
      const response = await chrome.runtime.sendMessage({ type: 'getRecordingState' })
      console.log('Received recording state:', response)
      setIsRecording(response.isRecording)
    } catch (error) {
      console.error('Failed to get recording state:', error)
    }
  }

  const testBackgroundConnection = async () => {
    try {
      console.log('Testing background connection...')
      const response = await chrome.runtime.sendMessage({ type: 'test' })
      console.log('Test response:', response)
      setLastActivity(`Test: ${response.message}`)
    } catch (error) {
      console.error('Failed to test background connection:', error)
      setLastActivity('Test failed: Background not responding')
    }
  }

  return (
    <div style={{ 
      padding: '20px', 
      width: '320px', 
      fontFamily: 'system-ui, -apple-system, sans-serif' 
    }}>
      <h3 style={{ 
        textAlign: 'center', 
        marginBottom: '20px',
        color: '#1a73e8' 
      }}>
        YouTube Auto Transcriber
      </h3>
      
      <div style={{ marginBottom: '20px' }}>
        <label htmlFor="api-key" style={{ 
          display: 'block', 
          marginBottom: '8px',
          fontWeight: '500',
          fontSize: '14px'
        }}>
          Google Cloud Speech API Key:
        </label>
        <input
          id="api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter your Google Cloud API key"
          style={{
            width: '100%',
            padding: '10px',
            marginBottom: '10px',
            border: '1px solid #dadce0',
            borderRadius: '4px',
            fontSize: '14px',
            boxSizing: 'border-box'
          }}
        />
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            onClick={saveApiKey}
            style={{
              background: '#1a73e8',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              flex: 1
            }}
          >
            Save Key
          </button>
          <button
            onClick={testApiKey}
            style={{
              background: '#34a853',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              flex: 1
            }}
          >
            Test Key
          </button>
        </div>
      </div>
      
      {/* Recording Status Section */}
      <div style={{ 
        marginBottom: '15px',
        padding: '12px',
        background: isRecording ? '#fce8e6' : '#f8f9fa',
        borderRadius: '4px',
        border: `1px solid ${isRecording ? '#f28b82' : '#e8eaed'}`,
        textAlign: 'center'
      }}>
        <div style={{ 
          fontSize: '16px', 
          fontWeight: '600',
          marginBottom: '8px',
          color: isRecording ? '#d93025' : '#5f6368'
        }}>
          {isRecording ? '🔴 RECORDING' : '⏸️ Not Recording'}
        </div>
        
        {isRecording && (
          <div style={{ fontSize: '14px', marginBottom: '8px' }}>
            Duration: <strong>{formatDuration(recordingDuration)}</strong>
          </div>
        )}
        
        {recordingMessage && (
          <div style={{ 
            fontSize: '12px', 
            color: '#1a73e8', 
            marginBottom: '8px',
            padding: '6px',
            background: '#e8f0fe',
            borderRadius: '4px',
            border: '1px solid #dadce0'
          }}>
            📍 {recordingMessage}
          </div>
        )}
        
        {chunksProcessed > 0 && (
          <div style={{ fontSize: '12px', color: '#5f6368', marginBottom: '4px' }}>
            Chunks processed: {chunksProcessed}
          </div>
        )}
        
        {lastActivity && (
          <div style={{ 
            fontSize: '11px', 
            color: '#5f6368',
            fontStyle: 'italic',
            marginTop: '4px'
          }}>
            {lastActivity}
          </div>
        )}
        
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            onClick={toggleRecording}
            disabled={isLoading}
            style={{
              background: isRecording ? '#d93025' : '#34a853',
              color: 'white',
              border: 'none',
              padding: '8px 16px',
              borderRadius: '4px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontSize: '14px',
              flex: 1,
              opacity: isLoading ? 0.7 : 1
            }}
          >
            {isLoading ? '⏳ Processing...' : (isRecording ? '⏹️ Stop Recording' : '🔴 Start Recording')}
          </button>
          
          <button
            onClick={testBackgroundConnection}
            style={{
              background: '#1a73e8',
              color: 'white',
              border: 'none',
              padding: '8px 12px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px'
            }}
          >
            Test
          </button>
        </div>
      </div>

      <div style={{ 
        textAlign: 'center', 
        marginBottom: '15px',
        padding: '12px',
        background: '#f8f9fa',
        borderRadius: '4px',
        border: '1px solid #e8eaed'
      }}>
        <p style={{ 
          fontSize: '14px', 
          margin: '0 0 8px 0',
          fontWeight: '500'
        }}>
          📹 How to use:
        </p>
        <p style={{ 
          fontSize: '13px', 
          color: '#5f6368',
          margin: 0,
          lineHeight: '1.4'
        }}>
          1. Go to any YouTube video<br/>
          2. Click the extension icon to start/stop<br/>
          3. Transcript files auto-download
        </p>
      </div>
      
      <div style={{
        padding: '12px',
        background: '#e8f0fe',
        borderRadius: '4px',
        fontSize: '12px',
        border: '1px solid #dadce0'
      }}>
        <div style={{ fontWeight: '500', marginBottom: '4px' }}>
          Status: <span style={{ color: status.includes('✅') ? '#137333' : status.includes('❌') ? '#d93025' : '#1a73e8' }}>{status}</span>
        </div>
        <div style={{ color: '#5f6368' }}>
          Auto-detects 18+ languages including Arabic, Chinese, Japanese, etc.
        </div>
        <div style={{ color: '#5f6368', marginTop: '4px' }}>
          Free tier: 60 minutes/month
        </div>
      </div>
    </div>
  )
}

export default IndexPopup
