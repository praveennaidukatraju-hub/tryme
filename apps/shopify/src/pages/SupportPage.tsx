import { Banner, BlockStack, Button, Card, InlineGrid, Page, Text } from '@shopify/polaris';

const CHANNELS = [
  {
    title: 'Email support',
    body: 'Send us the details and we usually reply within 24 hours.',
    action: 'Email us',
    url: 'mailto:support@tryme.com',
  },
  {
    title: 'Live chat',
    body: 'Talk to the team in real time during business hours.',
    action: 'Start a chat',
    url: 'https://app.tryme.com/support',
  },
];

export default function SupportPage() {
  return (
    <Page title="Support" subtitle="Two ways to reach the team.">
      <BlockStack gap="400">
        <Banner tone="info">
          Live chat is the fastest option during business hours. Email is answered within 24 hours
          the rest of the time.
        </Banner>
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
          {CHANNELS.map((channel) => (
            <Card key={channel.title}>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  {channel.title}
                </Text>
                <Text as="p" tone="subdued">
                  {channel.body}
                </Text>
                <Button url={channel.url} target="_blank">
                  {channel.action}
                </Button>
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
