FROM alpine:3.22
RUN apk add --no-cache postgresql17-client curl tzdata
COPY backup.sh /backup.sh
CMD ["sh", "/backup.sh"]
